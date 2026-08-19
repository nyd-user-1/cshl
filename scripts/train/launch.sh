#!/bin/bash
# train rig launcher (CSHL / RxivGPT) — ported from scripts/train-nsr/launch.sh
# at 8c1b05b. Same shape as the embed rig (role/SG/SSM/S3/self-terminate/SUBNET),
# extended for a training box: pulls train.sh + a converted jsonl slice from S3,
# runs the FlagEmbedding finetune, uploads weights, terminates.
#
# CHANGED vs the NSR original:
#   - names/paths parameterized (cshl-embed role, cshl-embed-rxiv bucket,
#     /cshl/embed/dburl, rxiv-encoder-bge-m3).
#   - DRYRUN=1 plans without touching AWS (same contract as the other rigs).
#   - NSR's Phase 3 ran a bespoke candidate-embed.py on the training box to
#     re-embed the corpus with the fresh checkpoint. DROPPED: that was a
#     single-threaded loop over 277k rows on the box that just finished
#     training. Our corpus is 433k and the embed rig already does this job,
#     sharded and resume-safe — so Phase 3 is now
#       MODEL_S3=s3://<bucket>/models/rxiv-encoder-bge-m3/<run>/final \
#       EMB_TABLE=preprint_embeddings_rxiv N=1 scripts/embed-nsr/launch.sh
#     which is one command against a rig that is already dry-run verified.
#   - TRAIN_ARGS passthrough so query/passage_max_len can be raised for this
#     corpus without editing the box script.
#
# Usage (run from repo root):
#   DRYRUN=1 MODE=train TRAIN_NAME=full ./scripts/train/launch.sh
#   MODE=rehearse TRAIN_NAME=rehearsal ./scripts/train/launch.sh   # Phase 1
#   MODE=train    TRAIN_NAME=full      ./scripts/train/launch.sh   # Phase 2
#   MODE=manual ./scripts/train/launch.sh                          # boot only, SSM in
set -euo pipefail
REGION=${REGION:-us-east-1}
TYPE=${TYPE:-g6e.xlarge}
PARAM=${PARAM:-/cshl/embed/dburl}
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
MODEL_NAME=${MODEL_NAME:-rxiv-encoder-bge-m3}
BASE_MODEL=${BASE_MODEL:-BAAI/bge-m3}
MODE=${MODE:?set MODE=rehearse, train, or manual}
WATCHDOG_MIN=${WATCHDOG_MIN:-360}
DRYRUN=${DRYRUN:-}
EXPECT_HOST=${EXPECT_HOST:-ep-orange-water-aut2eymf}
run() { if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: $*"; else "$@"; fi; }

if [ "$MODE" != manual ]; then
  TRAIN_NAME=${TRAIN_NAME:?set TRAIN_NAME (the s3://$BUCKET/train/<name>/ slice to pull)}
fi
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$MODE}
echo "run_id: $RUN_ID  base: $BASE_MODEL  out: models/$MODEL_NAME/$RUN_ID/final"

# 1. DB url into SSM (SecureString) from .env.local + endpoint fence. Never echoed.
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
DBHOST=$(printf '%s' "$DBVAL" | sed -E 's#^[^@]+@([^/?]+).*#\1#')
case "$DBHOST" in "$EXPECT_HOST".*) echo "db endpoint: $EXPECT_HOST (fence ok)";;
  *) echo "FENCE FAIL: endpoint is '$DBHOST', expected '$EXPECT_HOST.*' — refusing." >&2; exit 1;; esac
if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: aws ssm put-parameter --name $PARAM --type SecureString --value <redacted> --overwrite"
else aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null; echo "ssm param set: $PARAM"; fi

# 2. IAM — reuse the embed rig's role. Idempotent policy refresh, now including
#    s3:PutObject on models/* for the weight upload.
if [ -z "$DRYRUN" ] && ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  echo "role $ROLE does not exist — run scripts/embed-nsr/launch.sh once first"; exit 1
fi
run aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":[\"arn:aws:s3:::$BUCKET/logs/*\",\"arn:aws:s3:::$BUCKET/models/*\"]}]}"

# 3. train.sh to S3 (the box pulls it fresh every launch, same as worker.mjs)
if [ -z "$DRYRUN" ]; then
  aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3 mb s3://$BUCKET --region $REGION >/dev/null
  aws s3 cp scripts/train/train.sh s3://$BUCKET/train.sh >/dev/null
  echo "train.sh uploaded: s3://$BUCKET/train.sh"
  if [ "$MODE" != manual ]; then
    aws s3api head-object --bucket $BUCKET --key "train/$TRAIN_NAME/train.jsonl" >/dev/null 2>&1 \
      || { echo "s3://$BUCKET/train/$TRAIN_NAME/train.jsonl not found — run scripts/train/upload-slice.sh first"; exit 1; }
  fi
else
  echo "  [dry-run] would upload scripts/train/train.sh -> s3://$BUCKET/train.sh"
  echo "  [dry-run] would require s3://$BUCKET/train/${TRAIN_NAME:-<name>}/train.jsonl to exist"
fi

# 4. Security group — reuse the embed rig's (egress only, zero ingress)
if [ -z "$DRYRUN" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
  SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
  [ "$SG" != "None" ] || { echo "sg $SG_NAME not found — run scripts/embed-nsr/launch.sh once first"; exit 1; }
else SG='<sg-dryrun>'; fi
echo "sg: $SG"

# 5. AMI. NSR's correction, inherited: the embed rig's base DLAMI is driver-only
#    (fine for TEI-in-Docker, wrong for a host-python trainer). Use the PyTorch
#    DLAMI, which ships torch in /opt/pytorch. AMI= still overridable, and this
#    id should be re-resolved if the region/AMI ages out.
AMI=${AMI:-ami-012ba162b9cd2729c}
echo "ami: $AMI"

if [ "$MODE" = manual ]; then
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/manual.log 2>&1
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
echo "manual mode — up and waiting. SSM in: aws ssm start-session --target \$(curl -s http://169.254.169.254/latest/meta-data/instance-id) --region $REGION"
echo "train.sh is at s3://$BUCKET/train.sh"
EOF
)
else
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/train.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN   # watchdog: nothing runs past this many minutes
export AWS_DEFAULT_REGION=$REGION
# xtrace prints the RESOLVED value of an assignment or an env-var prefix, not
# just the command name. The NSR embed rig leaked its live Neon URL into three
# uploaded S3 logs exactly this way. Trace stays OFF from here through the
# train.sh invocation, which carries the credential.
set +x
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
aws s3 cp s3://$BUCKET/train.sh train.sh
chmod +x train.sh
export MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID BUCKET=$BUCKET MODEL_NAME=$MODEL_NAME BASE_MODEL=$BASE_MODEL
export EPOCHS=${EPOCHS:-1} BATCH=${BATCH:-16} QUERY_MAX_LEN=${QUERY_MAX_LEN:-128} PASSAGE_MAX_LEN=${PASSAGE_MAX_LEN:-512} GROUP_SIZE=${GROUP_SIZE:-8}
DATABASE_URL="\$DBURL" ./train.sh
set -x
aws s3 cp /var/log/train.log s3://$BUCKET/logs/cshl-train-$RUN_ID.log
shutdown -h now
EOF
)
fi
if [ -n "$DRYRUN" ]; then
  echo "───── dry-run: user-data ─────"; echo "$UD"; echo "───── end ─────"
  echo "  [dry-run] would run: aws ec2 run-instances --image-id $AMI --instance-type $TYPE --iam-instance-profile Name=$ROLE --security-group-ids $SG --instance-initiated-shutdown-behavior terminate --tag Name=cshl-train-$RUN_ID"
  exit 0
fi
aws ec2 run-instances --region $REGION \
  --image-id "$AMI" --instance-type $TYPE --count 1 \
  ${SUBNET:+--subnet-id $SUBNET} \
  --iam-instance-profile Name=$ROLE \
  --security-group-ids "$SG" \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":150,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-train-$RUN_ID}]" \
  --user-data "$UD" \
  --query 'Instances[0].InstanceId' --output text
