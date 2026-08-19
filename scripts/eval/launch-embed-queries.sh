#!/bin/bash
# launch-embed-queries.sh — LANE-EVAL Phase 2. Reuses the proven embed-nsr
# rig wholesale (IAM role, SG, DLAMI, TEI, SSM secret, self-terminate, S3
# log) for a single small job: embed ~10k rows in nsr_eval_queries. One box,
# one pass, no lane/boundary splitting (see scripts/eval/embed-queries-worker.mjs).
set -euo pipefail
REGION=us-east-1
TYPE=${TYPE:-g6e.xlarge}
PARAM=/nsr/embed/dburl
ROLE=nsr-embed
SG_NAME=nsr-embed-sg
BUCKET=nsr-embed-v2

DBVAL=$(grep "^DATABASE_URL_UNPOOLED=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env DATABASE_URL_UNPOOLED"; exit 1; }
aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null
echo "ssm param set: $PARAM"

aws iam get-role --role-name $ROLE >/dev/null 2>&1 || { echo "role $ROLE missing — run embed-nsr/launch.sh once first"; exit 1; }

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
[ "$SG" != "None" ] || { echo "sg $SG_NAME missing — run embed-nsr/launch.sh once first"; exit 1; }
echo "sg: $SG"

AMI=$(aws ssm get-parameter --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id --query Parameter.Value --output text --region $REGION)
echo "ami: $AMI"

aws s3 cp scripts/eval/embed-queries-worker.mjs s3://$BUCKET/worker-queries.mjs >/dev/null
echo "worker uploaded: s3://$BUCKET/worker-queries.mjs"

UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/embed-queries.log 2>&1
set +x  # never trace: DB URL from SSM would land in the uploaded log
shutdown -h +60   # watchdog: nothing runs past 1h
export AWS_DEFAULT_REGION=$REGION
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
docker run -d --gpus all -p 8080:80 --name tei ghcr.io/huggingface/text-embeddings-inference:89-1.8 \
  --model-id BAAI/bge-m3 --dtype float16 --max-client-batch-size 256 --max-batch-tokens 131072
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
mkdir -p /opt/embed && cd /opt/embed && npm init -y >/dev/null && npm i pg >/dev/null
aws s3 cp s3://$BUCKET/worker-queries.mjs worker.mjs
for t in \$(seq 1 60); do curl -sf http://127.0.0.1:8080/health && break; sleep 5; done
DATABASE_URL="\$DBURL" node worker.mjs
aws s3 cp /var/log/embed-queries.log s3://$BUCKET/logs/nsr-eval-queries-\$(date +%s).log
shutdown -h now
EOF
)

aws ec2 run-instances --region $REGION \
  --image-id "$AMI" --instance-type $TYPE --count 1 \
  ${SUBNET:+--subnet-id $SUBNET} \
  --iam-instance-profile Name=$ROLE \
  --security-group-ids "$SG" \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nsr-eval-queries}]" \
  --user-data "$UD" \
  --query 'Instances[0].InstanceId' --output text
