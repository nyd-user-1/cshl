#!/usr/bin/env bash
# Ephemeral HF publisher: t3.small pulls <S3 final dir> + card, pushes to a
# private HF repo (token from SSM /nsr/hf/token), uploads its log, terminates.
#   usage: SRC=s3://nsr-embed-v2/models/<m>/<run>/final/ REPO=NYSgpt/<name> CARD=s3://nsr-embed-v2/cards/<x>.md [TYPE=model] ./launch.sh
set -euo pipefail
REGION=us-east-1; ROLE=nsr-embed; BUCKET=nsr-embed-v2
SRC=${SRC:?}; REPO=${REPO:?}; CARD=${CARD:?}; TYPE=${TYPE:-model}
NAME=nsr-publish-$(echo "$REPO" | tr '/' '-')
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=nsr-embed-sg --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
AMI=$(aws ssm get-parameter --region $REGION --name /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id --query Parameter.Value --output text)
USERDATA=$(cat <<EOS
#!/bin/bash
set -uo pipefail
exec > /var/log/publish.log 2>&1
apt-get update -q && apt-get install -y -q python3-venv awscli >/dev/null
python3 -m venv /opt/hf && /opt/hf/bin/pip install -q huggingface_hub
mkdir -p /work && aws s3 sync --only-show-errors --exclude "checkpoint-*/*" --exclude "rehearsal/*" $SRC /work/
aws s3 cp --only-show-errors $CARD /work/README.md
export HF_TOKEN=\$(aws ssm get-parameter --region $REGION --with-decryption --name /nsr/hf/token --query Parameter.Value --output text)
/opt/hf/bin/python - <<'PY'
import os
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo("$REPO", repo_type="$TYPE", private=True, exist_ok=True)
info = api.upload_folder(folder_path="/work", repo_id="$REPO", repo_type="$TYPE", commit_message="NSR-CPT: weights + card")
print("UPLOADED", "$REPO", getattr(info, "commit_url", info))
PY
echo PUBLISH-DONE
aws s3 cp /var/log/publish.log s3://$BUCKET/logs/$NAME-\$(date +%s).log
shutdown -h now
EOS
)
ID=$(aws ec2 run-instances --region $REGION --image-id $AMI --instance-type t3.small --count 1 \
  --iam-instance-profile Name=$ROLE --security-group-ids $SG \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)
echo "instance: $ID ($NAME)"
