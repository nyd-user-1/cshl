#!/bin/bash
# launch-prep.sh — launcher for scripts/train/prep-qp3.sh (LANE-QP3 phases 1-2).
#
# Ported from scripts/train/launch.sh, keeping every part of that rig that has
# already been paid for: the SSM SecureString + endpoint fence, the `set +x`
# window around the credential, the reused embed role/SG, TYPE_MENU walked
# type-by-type across every offered AZ with the load-bearing `|| true`, a real
# watchdog, instance-initiated-shutdown-behavior=terminate, and DRYRUN.
#
# CHANGED vs launch.sh:
#   - payload is prep-qp3.sh, not train.sh, and there is no slice to require in
#     S3 (this box is what BUILDS it).
#   - the role policy gains s3:PutObject on train/* and prep/*: the prep box
#     writes the slice this bucket's train/ prefix, which launch.sh's policy
#     (logs/* + models/* only) does not permit. Without this the box would run
#     the whole pipeline and die on AccessDenied at the upload — a silent
#     failure that costs the entire box.
#   - the .mjs the box needs travel to s3://$BUCKET/$PREFIX/scripts/ on every
#     launch, same discipline as train.sh: the box pulls them fresh, never a
#     baked copy.
#
# Usage:
#   DRYRUN=1 ./scripts/train/launch-prep.sh
#   ./scripts/train/launch-prep.sh
set -euo pipefail
REGION=${REGION:-us-east-1}
TYPE_MENU=${TYPE_MENU:-${TYPE:-g6.2xlarge,g5.2xlarge,g6e.xlarge}}
PARAM=${PARAM:-/cshl/embed/dburl}
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
PREFIX=${PREFIX:-prep/qp3}
SLICE_NAME=${SLICE_NAME:-qpairs3}
QP2_RUN=${QP2_RUN:-20260819-232838-train}
FAMILY_TAKE=${FAMILY_TAKE:-MESH:45000,AUTHORKW:40000,OAKW:50000,EXTRACT:5000}
EXPECT_PAIRS=${EXPECT_PAIRS:-140000}
TOPK=${TOPK:-100}; SKIP_TOP=${SKIP_TOP:-5}; NEGS=${NEGS:-8}; CONC=${CONC:-16}
WATCHDOG_MIN=${WATCHDOG_MIN:-90}
DRYRUN=${DRYRUN:-}
EXPECT_HOST=${EXPECT_HOST:-ep-orange-water-aut2eymf}
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-prep}
run() { if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: $*"; else "$@"; fi; }
echo "run_id: $RUN_ID  slice: $SLICE_NAME  qp2: $QP2_RUN  watchdog: ${WATCHDOG_MIN}m"

# 1. DB url -> SSM, endpoint fence, never echoed.
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
DBHOST=$(printf '%s' "$DBVAL" | sed -E 's#^[^@]+@([^/?]+).*#\1#')
case "$DBHOST" in "$EXPECT_HOST".*) echo "db endpoint: $EXPECT_HOST (fence ok)";;
  *) echo "FENCE FAIL: endpoint is '$DBHOST', expected '$EXPECT_HOST.*' — refusing." >&2; exit 1;; esac
if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: aws ssm put-parameter --name $PARAM --type SecureString --value <redacted> --overwrite"
else aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null; echo "ssm param set: $PARAM"; fi

# 2. IAM — reuse the embed role, refresh the policy to include train/* + prep/*.
if [ -z "$DRYRUN" ] && ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  echo "role $ROLE does not exist — run scripts/embed-nsr/launch.sh once first"; exit 1
fi
run aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":\"arn:aws:s3:::$BUCKET\"},{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":[\"arn:aws:s3:::$BUCKET/logs/*\",\"arn:aws:s3:::$BUCKET/models/*\",\"arn:aws:s3:::$BUCKET/train/*\",\"arn:aws:s3:::$BUCKET/prep/*\"]}]}"

# 3. payload + the scripts the box runs, fresh every launch.
if [ -z "$DRYRUN" ]; then
  aws s3 cp scripts/train/prep-qp3.sh  s3://$BUCKET/$PREFIX/prep-qp3.sh          >/dev/null
  aws s3 cp scripts/train/from-mine.mjs s3://$BUCKET/$PREFIX/scripts/from-mine.mjs >/dev/null
  aws s3 cp scripts/train/mine-ance.mjs s3://$BUCKET/$PREFIX/scripts/mine-ance.mjs >/dev/null
  aws s3 cp scripts/eval/score.mjs      s3://$BUCKET/$PREFIX/scripts/score.mjs     >/dev/null
  echo "payload uploaded: s3://$BUCKET/$PREFIX/"
  for k in cshl-query-pairs.train.jsonl cshl-oakw-pairs.train.jsonl corpus-text.jsonl eval-v1/qrels.tsv eval-v1/queries.jsonl eval-2k/qrels.tsv eval-2k/queries.jsonl; do
    aws s3api head-object --bucket $BUCKET --key "$PREFIX/$k" >/dev/null 2>&1 \
      || { echo "MISSING INPUT s3://$BUCKET/$PREFIX/$k — upload it before launching"; exit 1; }
  done
  echo "all 7 inputs present in s3://$BUCKET/$PREFIX/"
else
  echo "  [dry-run] would upload prep-qp3.sh + from-mine.mjs + mine-ance.mjs + score.mjs"
  echo "  [dry-run] would require 7 inputs under s3://$BUCKET/$PREFIX/"
fi

# 4. SG (egress only, zero ingress) — the embed rig's.
if [ -z "$DRYRUN" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
  SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
  [ "$SG" != "None" ] || { echo "sg $SG_NAME not found"; exit 1; }
else SG='<sg-dryrun>'; fi
echo "sg: $SG"

# 5. PyTorch DLAMI (torch in /opt/pytorch) — same image the train rig uses.
AMI=${AMI:-ami-012ba162b9cd2729c}
echo "ami: $AMI"

UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/prep-qp3.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
set +x   # the DB URL is resolved below; xtrace would print it into the S3 log
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
aws s3 cp s3://$BUCKET/$PREFIX/prep-qp3.sh prep-qp3.sh
chmod +x prep-qp3.sh
export RUN_ID=$RUN_ID BUCKET=$BUCKET PREFIX=$PREFIX SLICE_NAME=$SLICE_NAME QP2_RUN=$QP2_RUN
export FAMILY_TAKE="$FAMILY_TAKE" EXPECT_PAIRS=$EXPECT_PAIRS TOPK=$TOPK SKIP_TOP=$SKIP_TOP NEGS=$NEGS CONC=$CONC REGION=$REGION
DATABASE_URL="\$DBURL" ./prep-qp3.sh; RC=\$?
set -x
echo "[launch-prep] prep-qp3.sh exited \$RC"
aws s3 cp /var/log/prep-qp3.log s3://$BUCKET/logs/cshl-prep-$RUN_ID.log
echo "\$RC" > /tmp/rc; aws s3 cp /tmp/rc s3://$BUCKET/logs/cshl-prep-$RUN_ID.rc
shutdown -h now
EOF
)

IFS=',' read -r -a TYPES <<< "$TYPE_MENU"
if [ -n "$DRYRUN" ]; then
  echo "───── dry-run: user-data ─────"; echo "$UD"; echo "───── end ─────"
  for t in "${TYPES[@]}"; do echo "  [dry-run]   try $t across every offered AZ"; done
  exit 0
fi

launch_in() {
  local type="$1" subnet="$2"
  aws ec2 run-instances --region $REGION \
    --image-id "$AMI" --instance-type "$type" --count 1 \
    ${subnet:+--subnet-id "$subnet"} \
    --iam-instance-profile Name=$ROLE \
    --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":200,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-prep-$RUN_ID},{Key=InstanceType,Value=$type}]" \
    --user-data "$UD" \
    --query 'Instances[0].InstanceId' --output text 2>&1
}

ID=""; PICKED_TYPE=""
for TYPE in "${TYPES[@]}"; do
  OFFERED=$(aws ec2 describe-instance-type-offerings --region $REGION --location-type availability-zone \
    --filters Name=instance-type,Values=$TYPE --query 'InstanceTypeOfferings[].Location' --output text)
  CANDIDATES=""
  for az in $OFFERED; do
    sn=$(aws ec2 describe-subnets --region $REGION --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$az \
           --query 'Subnets[0].SubnetId' --output text)
    [ "$sn" != "None" ] && CANDIDATES="$CANDIDATES $sn"
  done
  [ -n "$CANDIDATES" ] || { echo "type $TYPE: not offered in any AZ with a subnet — next type"; continue; }
  for sn in $CANDIDATES; do
    OUT=$(launch_in "$TYPE" "$sn") || true    # load-bearing: see launch.sh
    case "$OUT" in
      i-*) ID="$OUT"; PICKED_TYPE="$TYPE"; echo "launched: $ID ($TYPE, $sn)"; break 2 ;;
      *InsufficientInstanceCapacity*|*Unsupported*) echo "type $TYPE: no capacity in $sn — next AZ" ;;
      *) echo "type $TYPE: launch failed in $sn (non-capacity) — next type: $OUT"; break ;;
    esac
  done
done
[ -n "$ID" ] || { echo "NO CAPACITY IN ANY AZ FOR ANY TYPE IN MENU: $TYPE_MENU. Nothing launched." >&2; exit 1; }
echo "instance: $ID  type: $PICKED_TYPE  log: s3://$BUCKET/logs/cshl-prep-$RUN_ID.log"
