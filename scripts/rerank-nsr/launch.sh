#!/bin/bash
# rerank rig launcher (CSHL / RxivGPT) — ported from the NSR rig at 8c1b05b.
# CHANGED: role/SG/bucket/SSM/model-name parameterized with CSHL defaults; the
# groups come from scripts/rerank-nsr/to-groups.mjs (miner contract) instead of
# NSR pairs; 44b train.py still runs UNCHANGED, path flags only.
# original header follows.
# rerank-nsr launcher — same shape as scripts/train-nsr/launch.sh (role/SG/
# SSM/S3/self-terminate/SUBNET/AMI), extended for the cross-encoder reranker:
# pulls train.py (44b's, unchanged) + train.sh + a converted train-groups.jsonl
# slice from S3, runs the trainer, (MODE=train only) scores it against
# LANE-EVAL's frozen benchmark before shutdown. Same IAM role (nsr-embed),
# bucket cshl-embed-rxiv. TYPE_MENU + checkpoint-to-S3 added by the cshl-RR lane
# (see LANE-RERANK G2/G3); train.py still runs UNCHANGED, path flags only.
#
# Usage (run from repo root):
#   MODE=rehearse TRAIN_NAME=rehearsal ./scripts/rerank-nsr/launch.sh   # Phase 0
#   MODE=train    TRAIN_NAME=full      ./scripts/rerank-nsr/launch.sh   # Phase 1+2
#   MODE=manual ./scripts/rerank-nsr/launch.sh   # boot only, no auto-run —
#     SSM in by hand: aws ssm start-session --target <instance-id> --region us-east-1
set -euo pipefail
REGION=us-east-1
# TYPE_MENU: comma-separated instance types, walked in order, each across every
# AZ that offers it. Ported from scripts/train/launch.sh:32,139-231 (LANE-RERANK
# G2: the rig merge gave the ENCODER launcher type failover and never reached
# this file, which was still a single `run-instances` or bust).
TYPE_MENU=${TYPE_MENU:-${TYPE:-g6e.xlarge}}
PARAM=${PARAM:-/cshl/embed/dburl}
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
MODE=${MODE:?set MODE=rehearse, train, or manual}
WATCHDOG_MIN=${WATCHDOG_MIN:-180}
if [ "$MODE" != manual ]; then
  TRAIN_NAME=${TRAIN_NAME:?set TRAIN_NAME (the s3://$BUCKET/reranker/<name>/ slice to pull)}
fi
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$MODE}
echo "run_id: $RUN_ID"

# 1. DB url into SSM (SecureString) from .env.local — reuse the shared param.
#    Needed for MODE=train's Phase 2 scoring (candidate pools come from
#    nsr_embeddings if LANE-EVAL's per-query top-50 JSON isn't on disk).
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null
echo "ssm param set: $PARAM"

# 2. IAM role — reuse nsr-embed (created by the embed rig, extended by
#    train-nsr for models/*). Verified read-only before this lane launched:
#    read of $BUCKET/* and write of logs/* + models/* both already granted.
#    No delta applied here (nothing new needed).
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  echo "role $ROLE does not exist — run scripts/embed-nsr/launch.sh once first"; exit 1
fi

# 3. train.py (44b's, unchanged) + train.sh to S3 (the box pulls both fresh
#    every launch, same pattern as worker.mjs / train-nsr's train.sh).
aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3 mb s3://$BUCKET --region $REGION >/dev/null
aws s3 cp ${TRAIN_PY:-../44b/scripts/reranker/train.py} s3://$BUCKET/reranker/train.py >/dev/null
aws s3 cp scripts/rerank-nsr/train.sh s3://$BUCKET/reranker/train.sh >/dev/null
echo "train.py + train.sh uploaded: s3://$BUCKET/reranker/"
if [ "$MODE" != manual ]; then
  aws s3api head-object --bucket $BUCKET --key "reranker/train/$TRAIN_NAME/train-groups.jsonl" >/dev/null 2>&1 \
    || { echo "s3://$BUCKET/reranker/train/$TRAIN_NAME/train-groups.jsonl not found — upload it first (aws s3 cp <local> s3://$BUCKET/reranker/train/$TRAIN_NAME/train-groups.jsonl)"; exit 1; }
fi

# 4. Security group — reuse the embed rig's (egress only, zero ingress)
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
[ "$SG" != "None" ] || { echo "sg $SG_NAME not found — run scripts/embed-nsr/launch.sh once first"; exit 1; }
echo "sg: $SG"

# 5. AMI — the PyTorch DLAMI, NOT the embed rig's base DLAMI (non-negotiable
#    #1: 44b's trainer AMI, ships torch pre-installed; the base DLAMI cost
#    LANE-TRAIN four failed boots).
AMI=${AMI:-ami-012ba162b9cd2729c}
echo "ami: $AMI"

# 6. Launch one box.
if [ "$MODE" = manual ]; then
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/manual.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
echo "manual mode — up and waiting. SSM in: aws ssm start-session --target \$(curl -s http://169.254.169.254/latest/meta-data/instance-id) --region $REGION"
echo "train.py/train.sh at s3://$BUCKET/reranker/ — pull with: aws s3 cp s3://$BUCKET/reranker/train.sh . && chmod +x train.sh"
echo "DB url: aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text"
EOF
)
else
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/train.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN   # watchdog: nothing runs past this many minutes
export AWS_DEFAULT_REGION=$REGION
# xtrace prints the RESOLVED value of an assignment, not just the command —
# the credential leak fixed in commit dfcbb25. Trace stays off across the
# SSM fetch and the train.sh invocation, which also carries the credential.
# No DB credential is fetched here. train.sh's scoring step was removed when
# the rig was ported (its §5), so nothing on this box reads DATABASE_URL —
# grep confirms zero references. The NSR rig shipped the credential because it
# scored on-box; carrying it forward would contradict train.sh's own header and
# put a live Neon URL on a GPU box for no reason. (LANE-RERANK G7.)
aws s3 cp s3://$BUCKET/reranker/train.sh train.sh
chmod +x train.sh
export MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID BUCKET=$BUCKET EPOCHS=${EPOCHS:-1} MAXHOURS=${MAXHOURS:-0.5} CKPT_STEPS=${CKPT_STEPS:-1000} CKPT_SYNC_INTERVAL=${CKPT_SYNC_INTERVAL:-240} RESUME=${RESUME:-0}
./train.sh
set -x
aws s3 cp /var/log/train.log s3://$BUCKET/logs/cshl-reranker-$RUN_ID.log
shutdown -h now
EOF
)
fi
launch_in() {
  local type="$1" subnet="$2"
  aws ec2 run-instances --region $REGION \
    --image-id "$AMI" --instance-type "$type" --count 1 \
    ${subnet:+--subnet-id "$subnet"} \
    --iam-instance-profile Name=$ROLE \
    --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":150,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-reranker-$RUN_ID},{Key=InstanceType,Value=$type}]" \
    --user-data "$UD" \
    --query 'Instances[0].InstanceId' --output text 2>&1
}

IFS=',' read -r -a TYPES <<< "$TYPE_MENU"
if [ -n "${DRYRUN:-}" ]; then
  echo "───── dry-run: user-data ─────"; echo "$UD"; echo "───── end ─────"
  for t in "${TYPES[@]}"; do echo "  [dry-run] would try $t across every offered AZ"; done
  exit 0
fi

# `|| true` on the OUT= assignment is load-bearing, not decorative: under
# `set -e` a capacity error returned by a command substitution IN AN ASSIGNMENT
# exits the whole script, so a loop whose only job is "try the next AZ" can
# never reach iteration two. Same bug, same fix, as the embed/train rigs.
ID=""; PICKED_TYPE=""
for TYPE in "${TYPES[@]}"; do
  if [ -n "${SUBNET:-}" ]; then
    CANDIDATES="$SUBNET"
  else
    OFFERED=$(aws ec2 describe-instance-type-offerings --region $REGION --location-type availability-zone \
      --filters Name=instance-type,Values=$TYPE --query 'InstanceTypeOfferings[].Location' --output text)
    CANDIDATES=""
    for az in $OFFERED; do
      sn=$(aws ec2 describe-subnets --region $REGION --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$az \
             --query 'Subnets[0].SubnetId' --output text)
      [ "$sn" != "None" ] && CANDIDATES="$CANDIDATES $sn"
    done
  fi
  [ -n "$CANDIDATES" ] || { echo "type $TYPE: not offered in any AZ with a subnet — next type"; continue; }
  for sn in $CANDIDATES; do
    OUT=$(launch_in "$TYPE" "$sn") || true
    case "$OUT" in
      i-*) ID="$OUT"; PICKED_TYPE="$TYPE"; echo "launched: $ID ($TYPE, $sn)"; break 2 ;;
      *InsufficientInstanceCapacity*|*Unsupported*) echo "type $TYPE: no capacity in $sn — next AZ" ;;
      *) echo "type $TYPE: launch failed in $sn (non-capacity error) — next type: $OUT"; break ;;
    esac
  done
done
[ -n "$ID" ] || { echo "NO CAPACITY IN ANY AZ FOR ANY TYPE IN MENU: $TYPE_MENU. Nothing launched." >&2; exit 1; }
echo "instance: $ID  type: $PICKED_TYPE  run_id: $RUN_ID"
echo "watchdog: $WATCHDOG_MIN min · ckpt every ${CKPT_STEPS:-1000} steps, synced to S3 every ${CKPT_SYNC_INTERVAL:-240}s"
echo "$ID"
