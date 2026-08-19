#!/bin/bash
# launch-embed-commercial.sh — LANE-EVAL Phase 3 Arm C. No GPU needed (just
# HTTPS calls to Bedrock), so a plain Amazon Linux 2023 box under the same
# nsr-embed role/SG/bucket/SSM-param as the embed rig, self-terminating.
set -euo pipefail
REGION=us-east-1
TYPE=${TYPE:-t3.small}
PARAM=/nsr/embed/dburl
ROLE=nsr-embed
SG_NAME=nsr-embed-sg
BUCKET=nsr-embed-v2

DBVAL=$(grep "^DATABASE_URL_UNPOOLED=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env DATABASE_URL_UNPOOLED"; exit 1; }
aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null
echo "ssm param set: $PARAM"

aws iam get-role --role-name $ROLE >/dev/null 2>&1 || { echo "role $ROLE missing"; exit 1; }
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
[ "$SG" != "None" ] || { echo "sg $SG_NAME missing"; exit 1; }
echo "sg: $SG"

AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text --region $REGION)
echo "ami: $AMI"

aws s3 cp scripts/eval/embed-commercial-worker.mjs s3://$BUCKET/worker-commercial.mjs >/dev/null
echo "worker uploaded: s3://$BUCKET/worker-commercial.mjs"

UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/embed-commercial.log 2>&1
set +x  # never trace: DB URL from SSM would land in the uploaded log
shutdown -h +90   # watchdog: nothing runs past 1.5h
export AWS_DEFAULT_REGION=$REGION
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
mkdir -p /opt/embed && cd /opt/embed && npm init -y >/dev/null
npm i pg @aws-sdk/client-bedrock-runtime >/dev/null
aws s3 cp s3://$BUCKET/worker-commercial.mjs worker.mjs
DATABASE_URL="\$DBURL" node worker.mjs
aws s3 cp /var/log/embed-commercial.log s3://$BUCKET/logs/nsr-eval-commercial-\$(date +%s).log
shutdown -h now
EOF
)

aws ec2 run-instances --region $REGION \
  --image-id "$AMI" --instance-type $TYPE --count 1 \
  ${SUBNET:+--subnet-id $SUBNET} \
  --iam-instance-profile Name=$ROLE \
  --security-group-ids "$SG" \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nsr-eval-commercial}]" \
  --user-data "$UD" \
  --query 'Instances[0].InstanceId' --output text
