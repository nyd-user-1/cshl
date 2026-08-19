#!/usr/bin/env bash
# serve rig (CSHL / RxivGPT) — one small always-on box serving our models for
# the app's kill-switch. Ported from the NSR rig at 8c1b05b.
#   :8080  TEI  encoder    (query encoder; /embed)
#   :8081  TEI  reranker   (cross-encoder; /rerank)
# Both behind TEI's --api-key (value from SSM, $KEY_PARAM).
#
# TWO ARMS, selected with ARM=:
#   ARM=cshl   (default) our fine-tuned weights from S3 (models/<name>/<run>/final)
#              — no HF dependency at serve time. Needs ENC_RUN (and RR_RUN).
#   ARM=medcpt NCBI MedCPT straight from the Hub — no training, no S3, no runs.
#              ncbi/MedCPT-Query-Encoder (:8080) + ncbi/MedCPT-Cross-Encoder (:8081).
#              See the DIMENSION WARNING below before pointing the app at :8080.
#
# CHANGED vs the NSR original:
#   - ARM knob + the whole MedCPT variant (new).
#   - SSM/role/bucket/name parameterized: /cshl/serve/api-key, cshl-embed,
#     cshl-embed-rxiv, cshl-serve.
#   - DRYRUN=1 plans without touching AWS (same contract as the embed rig).
#   - ENC_RUN is only required for ARM=cshl (MedCPT has no run id).
#
# DIMENSION WARNING (MedCPT): MedCPT is an ASYMMETRIC 768-d dual encoder —
# queries go through MedCPT-Query-Encoder (max 64 tokens), documents through
# MedCPT-Article-Encoder (max 512 tokens), and the two are only comparable to
# each other. It is NOT a drop-in for the 1024-d bge-m3 space: api/_lib/embed.ts
# hard-fails a vector whose length != 1024, and the corpus sidecar is
# vector(1024). Serving MedCPT as the DENSE arm therefore needs (a) a
# preprint_embeddings_medcpt vector(768) sidecar embedded with the ARTICLE
# encoder and (b) an api/ change. The CROSS-ENCODER (:8081) has no such
# problem — scores are dimensionless, so MedCPT-Cross-Encoder is a genuine
# drop-in A/B for NSR_RERANKER_URL today.
#
# Stop with `aws ec2 stop-instances`; the app falls back to stock bge-m3 via
# Cloudflare the moment SEARCH_ENCODER != nsr or the box is unreachable.
# Cost: t3.large on-demand ~= $0.083/h (~$2/day while on).
set -euo pipefail
REGION=${REGION:-us-east-1}
TYPE=${TYPE:-t3.large}
ARM=${ARM:-cshl}
ROLE=${ROLE:-cshl-embed}             # created by scripts/embed-nsr/launch.sh
BUCKET=${BUCKET:-cshl-embed-rxiv}
KEY_PARAM=${KEY_PARAM:-/cshl/serve/api-key}
NAME=${NAME:-cshl-serve-$ARM}
SG_NAME=${SG_NAME:-cshl-serve-sg}
ENC_MODEL_NAME=${ENC_MODEL_NAME:-rxiv-encoder-bge-m3}
RR_MODEL_NAME=${RR_MODEL_NAME:-rxiv-reranker-gte-modernbert}
DRYRUN=${DRYRUN:-}
run() { if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: $*"; else "$@"; fi; }

case "$ARM" in
  cshl)
    ENC_RUN=${ENC_RUN:?ARM=cshl needs ENC_RUN=<run-id> (models/$ENC_MODEL_NAME/<run>/final)}
    RR_RUN=${RR_RUN:-}   # optional at launch; attach later with attach-reranker.sh
    ENC_SRC="s3://$BUCKET/models/$ENC_MODEL_NAME/$ENC_RUN/final"
    RR_SRC="${RR_RUN:+s3://$BUCKET/models/$RR_MODEL_NAME/$RR_RUN/final}"
    ENC_ID=/data; RR_ID=/data
    ENC_MOUNT=/models/enc; RR_MOUNT=/models/rr
    ;;
  medcpt)
    ENC_SRC=""; RR_SRC=""
    ENC_ID=${ENC_ID:-ncbi/MedCPT-Query-Encoder}
    RR_ID=${RR_ID:-ncbi/MedCPT-Cross-Encoder}
    # Hub ids: mount a persistent HF cache at TEI's default --huggingface-hub-cache
    # (/data) so a container restart does not re-download 110M params.
    ENC_MOUNT=/models/hf; RR_MOUNT=/models/hf
    ;;
  *) echo "unknown ARM=$ARM (want cshl|medcpt)"; exit 1 ;;
esac
echo "arm: $ARM  encoder: ${ENC_SRC:-$ENC_ID}  reranker: ${RR_SRC:-$RR_ID}"

# api key in SSM (created once; never in argv/user-data plaintext)
if [ -z "$DRYRUN" ] && ! aws ssm get-parameter --region $REGION --name $KEY_PARAM >/dev/null 2>&1; then
  aws ssm put-parameter --region $REGION --name $KEY_PARAM --type SecureString --value "$(openssl rand -hex 24)" >/dev/null
fi
[ -n "$DRYRUN" ] && echo "  [dry-run] would ensure SSM SecureString $KEY_PARAM (random 24-byte hex)"
run aws iam put-role-policy --role-name $ROLE --policy-name serve-apikey --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$KEY_PARAM\"}]}"

if [ -z "$DRYRUN" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
  SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
  if [ "$SG" = "None" ]; then
    SG=$(aws ec2 create-security-group --group-name $SG_NAME --description "cshl-serve TEI 8080/8081 (api-key auth)" --vpc-id $VPC --query GroupId --output text --region $REGION)
    aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 8080-8081 --cidr 0.0.0.0/0 --region $REGION >/dev/null
  fi
  AMI=$(aws ssm get-parameter --region $REGION --name /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id --query Parameter.Value --output text)
else
  SG='<sg-dryrun>'; AMI='<ami-resolved-at-launch>'
fi
echo "sg: $SG  ami: $AMI"

USERDATA=$(cat <<EOS
#!/bin/bash
set -uo pipefail
exec > /var/log/serve.log 2>&1
apt-get update -q && apt-get install -y -q docker.io awscli >/dev/null
systemctl enable --now docker
mkdir -p /models/enc /models/rr /models/hf
${ENC_SRC:+aws s3 sync --only-show-errors $ENC_SRC /models/enc}
${RR_SRC:+aws s3 sync --only-show-errors $RR_SRC /models/rr}
KEY=\$(aws ssm get-parameter --region $REGION --with-decryption --name $KEY_PARAM --query Parameter.Value --output text)
IMG=ghcr.io/huggingface/text-embeddings-inference:cpu-1.8
docker run -d --restart unless-stopped -p 8080:80 -v $ENC_MOUNT:/data --name tei-enc \$IMG --model-id $ENC_ID --api-key "\$KEY" --max-client-batch-size 32 --auto-truncate
docker run -d --restart unless-stopped -p 8081:80 -v $RR_MOUNT:/data --name tei-rr \$IMG --model-id $RR_ID --api-key "\$KEY" --max-client-batch-size 64 --max-batch-tokens 4096 --max-batch-requests 8 --auto-truncate
for t in \$(seq 1 90); do curl -sf http://127.0.0.1:8080/health && break; sleep 5; done
echo SERVE-READY
EOS
)
if [ -n "$DRYRUN" ]; then
  echo "───── dry-run: user-data ─────"; echo "$USERDATA"; echo "───── end ─────"
  echo "  [dry-run] would run: aws ec2 run-instances --image-id $AMI --instance-type $TYPE --iam-instance-profile Name=$ROLE --security-group-ids $SG --associate-public-ip-address --tag Name=$NAME"
  exit 0
fi
ID=$(aws ec2 run-instances --region $REGION --image-id $AMI --instance-type $TYPE --count 1 \
  --iam-instance-profile Name=$ROLE --security-group-ids $SG --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)
echo "instance: $ID"
aws ec2 wait instance-running --region $REGION --instance-ids $ID
IP=$(aws ec2 describe-instances --region $REGION --instance-ids $ID --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "public ip: $IP  (encoder http://$IP:8080  reranker http://$IP:8081; api key in SSM $KEY_PARAM)"
echo "app wiring: NSR_ENCODER_URL=http://$IP:8080/embed  NSR_RERANKER_URL=http://$IP:8081  NSR_SERVE_KEY=<the SSM value>  SEARCH_ENCODER=nsr"
