#!/usr/bin/env bash
# nsr-serve — one small always-on box serving NSR-CPT for the app's kill-switch:
#   :8080  TEI  NYSgpt/nsr-encoder-bge-m3        (query encoder; /embed)
#   :8081  TEI  NYSgpt/nsr-reranker-gte-modernbert (cross-encoder; /rerank)
# Both behind TEI's --api-key (value from SSM /nsr/serve/api-key). Weights are
# pulled from S3 (models/<name>/<run>/final) — no HF dependency at serve time.
# Stop with `aws ec2 stop-instances`; the app falls back to stock bge-m3 via
# Cloudflare the moment SEARCH_ENCODER != nsr or the box is unreachable.
# Equivalent to (and swappable for) HF Inference Endpoints once the HF token has
# the inference.endpoints scope. Cost: t3.large on-demand ≈ $0.083/h.
set -euo pipefail
REGION=us-east-1
TYPE=${TYPE:-t3.large}
ROLE=nsr-embed                       # already has SSM + s3:GetObject on nsr-embed-v2/*
BUCKET=nsr-embed-v2
ENC_RUN=${ENC_RUN:?set ENC_RUN=<run-id> (models/nsr-encoder-bge-m3/<run>/final)}
RR_RUN=${RR_RUN:-}   # optional at launch; attach later with scripts/serve-nsr/attach-reranker.sh
NAME=nsr-serve

# api key in SSM (created once; never in argv/user-data plaintext)
if ! aws ssm get-parameter --region $REGION --name /nsr/serve/api-key >/dev/null 2>&1; then
  aws ssm put-parameter --region $REGION --name /nsr/serve/api-key --type SecureString --value "$(openssl rand -hex 24)" >/dev/null
fi
aws iam put-role-policy --role-name $ROLE --policy-name serve-apikey --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter/nsr/serve/api-key\"}]}"

VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=nsr-serve-sg Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name nsr-serve-sg --description "nsr-serve TEI 8080/8081 (api-key auth)" --vpc-id $VPC --query GroupId --output text --region $REGION)
  aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 8080-8081 --cidr 0.0.0.0/0 --region $REGION >/dev/null
fi
AMI=$(aws ssm get-parameter --region $REGION --name /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id --query Parameter.Value --output text)

USERDATA=$(cat <<EOS
#!/bin/bash
set -euo pipefail
exec > /var/log/serve.log 2>&1
apt-get update -q && apt-get install -y -q docker.io awscli >/dev/null
systemctl enable --now docker
mkdir -p /models/enc /models/rr
aws s3 sync --only-show-errors s3://$BUCKET/models/nsr-encoder-bge-m3/$ENC_RUN/final /models/enc
[ -n "$RR_RUN" ] && aws s3 sync --only-show-errors s3://$BUCKET/models/nsr-reranker-gte-modernbert/$RR_RUN/final /models/rr || true
KEY=\$(aws ssm get-parameter --region $REGION --with-decryption --name /nsr/serve/api-key --query Parameter.Value --output text)
IMG=ghcr.io/huggingface/text-embeddings-inference:cpu-1.8
docker run -d --restart unless-stopped -p 8080:80 -v /models/enc:/data/model --name tei-enc \$IMG --model-id /data/model --api-key "\$KEY" --max-client-batch-size 32
[ -n "$RR_RUN" ] && docker run -d --restart unless-stopped -p 8081:80 -v /models/rr:/data/model  --name tei-rr  \$IMG --model-id /data/model --api-key "\$KEY" --max-client-batch-size 64 --max-batch-tokens 4096 --max-batch-requests 8 --auto-truncate || true
for t in \$(seq 1 90); do curl -sf http://127.0.0.1:8080/health && break; sleep 5; done
echo SERVE-READY
EOS
)
ID=$(aws ec2 run-instances --region $REGION --image-id $AMI --instance-type $TYPE --count 1 \
  --iam-instance-profile Name=$ROLE --security-group-ids $SG --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)
echo "instance: $ID"
aws ec2 wait instance-running --region $REGION --instance-ids $ID
IP=$(aws ec2 describe-instances --region $REGION --instance-ids $ID --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "public ip: $IP  (encoder http://$IP:8080  reranker http://$IP:8081; api key in SSM /nsr/serve/api-key)"
