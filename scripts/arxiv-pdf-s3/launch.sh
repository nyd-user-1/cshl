#!/bin/bash
# arxiv-pdf-s3 launcher — one c6i.xlarge that streams the arXiv GCS mirror into
# S3 and terminates itself. Modeled on 44b/scripts/embed-v2/launch.sh, with one
# deliberate difference: NO database credential is put in SSM or on the box.
# The instance's only output is s3://$BUCKET/logs/*.jsonl; the Neon write-back
# runs from the laptop (`ingest-arxiv.mjs writeback`).
#
# Prereq: scripts/ingest-arxiv.mjs resolve  →  data/arxiv/worklist-resolved.csv
# Usage:  ./scripts/arxiv-pdf-s3/launch.sh
set -euo pipefail
REGION=${REGION:-us-east-1}
BUCKET=${BUCKET:-nsr-pdfs}
TYPE=${TYPE:-c6i.xlarge}
N=${N:-1}
CONC=${CONC:-16}
ROLE=nsr-arxiv-pdfs
SG_NAME=nsr-arxiv-sg
WORKLIST=${WORKLIST:-data/arxiv/worklist-resolved.csv}

[ -s "$WORKLIST" ] || { echo "no worklist at $WORKLIST — run \`ingest-arxiv.mjs resolve\` first"; exit 1; }

# 1. Ship the worklist + the worker to S3 (the box pulls both; nothing is baked in)
aws s3 cp "$WORKLIST" "s3://$BUCKET/worklist-resolved.csv" --region $REGION >/dev/null
aws s3 cp scripts/arxiv-pdf-s3/worker.mjs "s3://$BUCKET/worker.mjs" --region $REGION >/dev/null
echo "uploaded worklist ($(wc -l < "$WORKLIST" | tr -d ' ') rows) + worker to s3://$BUCKET/"

# 2. IAM role — SSM core for debugging, read the two inputs, write PDFs + logs
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name $ROLE --policy-name rw-pdf-bucket --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::$BUCKET\"}]}"
  aws iam create-instance-profile --instance-profile-name $ROLE >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $ROLE --role-name $ROLE
  echo "iam role created; waiting for propagation"; sleep 15
fi

# 3. Security group — egress only, zero ingress (SSM Session Manager still works)
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name $SG_NAME --description "nsr arxiv pdf fetch, egress-only" --vpc-id $VPC --query GroupId --output text --region $REGION)
fi
echo "sg: $SG"

# 4. Amazon Linux 2023 — aws CLI v2 is preinstalled, so user-data stays short
AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text --region $REGION)
echo "ami: $AMI"

for i in $(seq 0 $((N-1))); do
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/arxiv-pdf.log 2>&1
set -x
shutdown -h +240            # watchdog: nothing on this box outlives 4 hours
export AWS_DEFAULT_REGION=$REGION
dnf install -y nodejs npm
mkdir -p /opt/fetch && cd /opt/fetch
npm init -y >/dev/null && npm i @aws-sdk/client-s3 >/dev/null
aws s3 cp s3://$BUCKET/worker.mjs worker.mjs
aws s3 cp s3://$BUCKET/worklist-resolved.csv worklist.csv
BUCKET=$BUCKET CONC=$CONC PART=$i PARTS=$N node worker.mjs worklist.csv
aws s3 cp /var/log/arxiv-pdf.log s3://$BUCKET/logs/instance-$i.log
shutdown -h now             # work is done — stop paying for the box
EOF
)
  aws ec2 run-instances --region $REGION \
    --image-id "$AMI" --instance-type $TYPE --count 1 \
    --iam-instance-profile Name=$ROLE \
    --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nsr-arxiv-pdf-$i}]" \
    --user-data "$UD" \
    --query 'Instances[0].InstanceId' --output text
done
