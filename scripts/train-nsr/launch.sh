#!/bin/bash
# train-nsr launcher — same shape as scripts/embed-nsr/launch.sh (role/SG/SSM/
# S3/self-terminate/SUBNET), extended for a training box: pulls train.sh +
# a converted jsonl slice from S3 instead of computing DB lane bounds, runs
# the FlagEmbedding finetuner, then (MODE=train only) candidate-embeds the
# frozen corpus + eval queries before shutdown.
# DB URL travels .env.local → SSM SecureString → instance at boot, same as
# the embed rig; needed here only for the Phase 3 candidate-embed writes.
#
# Usage (run from repo root):
#   MODE=rehearse TRAIN_NAME=rehearsal ./scripts/train-nsr/launch.sh   # Phase 1
#   MODE=train    TRAIN_NAME=full      ./scripts/train-nsr/launch.sh   # Phase 2+3
#   MODE=manual ./scripts/train-nsr/launch.sh   # boot only, no auto-run —
#     SSM in by hand: aws ssm start-session --target <instance-id> --region us-east-1
set -euo pipefail
REGION=us-east-1
TYPE=${TYPE:-g6e.xlarge}
PARAM=/nsr/embed/dburl
ROLE=nsr-embed
SG_NAME=nsr-embed-sg
BUCKET=nsr-embed-v2
MODE=${MODE:?set MODE=rehearse, train, or manual}
WATCHDOG_MIN=${WATCHDOG_MIN:-360}
if [ "$MODE" != manual ]; then
  TRAIN_NAME=${TRAIN_NAME:?set TRAIN_NAME (the s3://$BUCKET/train/<name>/ slice to pull)}
fi
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$MODE}
echo "run_id: $RUN_ID"

# 1. DB url into SSM (SecureString) from .env.local — reuse the embed rig's
#    param, never echoed. Needed for the Phase 3 candidate-embed write.
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null
echo "ssm param set: $PARAM"

# 2. IAM role — reuse nsr-embed (created by the embed rig). Idempotent policy
#    refresh, same pattern as launch.sh: read the one param, read anything
#    under the bucket, write logs/* AND (new) models/* for weight uploads.
#    This is the policy delta identified read-only in Phase 0 — applying it
#    here, at launch time, is the first time it is actually applied.
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  echo "role $ROLE does not exist — run scripts/embed-nsr/launch.sh once first"; exit 1
fi
aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":[\"arn:aws:s3:::$BUCKET/logs/*\",\"arn:aws:s3:::$BUCKET/models/*\"]}]}"

# 3. train.sh to S3 (the box pulls it fresh every launch, same as worker.mjs).
#    manual mode doesn't auto-run train.sh, but upload it anyway so it's
#    right there on the box to run by hand once the working command is found.
aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3 mb s3://$BUCKET --region $REGION >/dev/null
aws s3 cp scripts/train-nsr/train.sh s3://$BUCKET/train.sh >/dev/null
aws s3 cp scripts/train-nsr/candidate-embed.py s3://$BUCKET/candidate-embed.py >/dev/null
echo "train.sh + candidate-embed.py uploaded: s3://$BUCKET/"
if [ "$MODE" != manual ]; then
  aws s3api head-object --bucket $BUCKET --key "train/$TRAIN_NAME/train.jsonl" >/dev/null 2>&1 \
    || { echo "s3://$BUCKET/train/$TRAIN_NAME/train.jsonl not found — run upload-slice.sh first"; exit 1; }
fi

# 4. Security group — reuse the embed rig's (egress only, zero ingress)
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
[ "$SG" != "None" ] || { echo "sg $SG_NAME not found — run scripts/embed-nsr/launch.sh once first"; exit 1; }
echo "sg: $SG"

# 5. AMI. Lead correction (2026-08-17, after 4 failed boots): the embed rig's
#    base DLAMI (`base-oss-nvidia-driver-gpu-ubuntu-22.04`) is driver-only,
#    no torch/python host package — fine for LANE-EMBED (Docker/TEI only),
#    wrong here. Default to 44b's trainer AMI instead (`44b/scripts/reranker/
#    provision-gpu-box.sh:18`): "Deep Learning OSS Nvidia Driver AMI GPU
#    PyTorch 2.7 (Ubuntu 22.04)" — ships torch pre-installed. AMI= still
#    overridable.
AMI=${AMI:-ami-012ba162b9cd2729c}
echo "ami: $AMI"

# 6. Launch one box. No lane-bounds query — training pulls a fixed jsonl slice
#    from S3, it doesn't claim DB row ranges like the embed worker does.
if [ "$MODE" = manual ]; then
  # No auto-run: box boots, waits for an SSM Session Manager shell. Watchdog
  # is the only automated thing that happens — self-terminate if a human
  # forgets to, well within the $15 cap even at $1.861/h.
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/manual.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
echo "manual mode — up and waiting. SSM in: aws ssm start-session --target \$(curl -s http://169.254.169.254/latest/meta-data/instance-id) --region $REGION"
echo "train.sh is at s3://$BUCKET/train.sh — pull with: aws s3 cp s3://$BUCKET/train.sh . && chmod +x train.sh"
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
# xtrace prints the RESOLVED value of an assignment or a command's env-var
# prefix, not just the command name — the embed rig's launch.sh has this
# exact bug, confirmed leaking the live Neon URL into 3 uploaded S3 logs
# (embed, eval, and this rehearsal's first attempt). Trace stays off from
# here through the train.sh invocation, which also carries the credential.
set +x
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
aws s3 cp s3://$BUCKET/train.sh train.sh
chmod +x train.sh
export MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID BUCKET=$BUCKET
DATABASE_URL="\$DBURL" ./train.sh
set -x
aws s3 cp /var/log/train.log s3://$BUCKET/logs/nsr-train-$RUN_ID.log
shutdown -h now
EOF
)
fi
aws ec2 run-instances --region $REGION \
  --image-id "$AMI" --instance-type $TYPE --count 1 \
  ${SUBNET:+--subnet-id $SUBNET} \
  --iam-instance-profile Name=$ROLE \
  --security-group-ids "$SG" \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":150,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nsr-train-$RUN_ID}]" \
  --user-data "$UD" \
  --query 'Instances[0].InstanceId' --output text
