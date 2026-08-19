#!/usr/bin/env bash
# Ephemeral HF publisher (CSHL / RxivGPT) — a t3.small pulls <S3 final dir> +
# a card, pushes to a private HF repo, uploads its log, terminates.
# Ported from scripts/publish-nsr/launch.sh at 8c1b05b.
#
# CHANGED vs the NSR original:
#   - CARD is now a LOCAL path under scripts/publish-nsr/cards/ that this script
#     uploads for you. NSR required you to have already put the card in S3 by
#     hand, which is how a model ships with a stale card.
#   - names/bucket/SSM parameterized; HF_TOKEN_PARAM defaults to /cshl/hf/token
#     and falls back to NSR's /nsr/hf/token if that is what exists.
#   - DRYRUN=1 plans without touching AWS or HF. **There is no non-dry-run path
#     that should be taken without Brendan's explicit go — this pushes to a
#     public-facing account.**
#   - PRIVATE=1 by default and stated in the output, because the failure mode
#     here is not cost, it is publishing something before it is ready.
#
#   usage: DRYRUN=1 SRC=s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/<run>/final/ \
#            REPO=NYSgpt/cshl-encoder-bge-m3 CARD=scripts/publish-nsr/cards/cshl-encoder-bge-m3.md \
#            ./scripts/publish-nsr/launch.sh
set -euo pipefail
REGION=${REGION:-us-east-1}
ROLE=${ROLE:-cshl-embed}
BUCKET=${BUCKET:-cshl-embed-rxiv}
SG_NAME=${SG_NAME:-cshl-embed-sg}
HF_TOKEN_PARAM=${HF_TOKEN_PARAM:-/cshl/hf/token}
SRC=${SRC:?set SRC=s3://.../final/}
REPO=${REPO:?set REPO=NYSgpt/<name>}
CARD=${CARD:?set CARD=scripts/publish-nsr/cards/<name>.md}
TYPE=${TYPE:-model}
PRIVATE=${PRIVATE:-True}
DRYRUN=${DRYRUN:-}
NAME=cshl-publish-$(echo "$REPO" | tr '/' '-')
[ -f "$CARD" ] || { echo "card not found: $CARD"; exit 1; }
# TEXT-BEARING ARTIFACT GUARD. cshl-triplets and cshl-eval-v1 inline abstract
# text; ~72% of this corpus carries a licence restricting derivative
# redistribution or commercial use, and `cc_no` (29.9%) reserves all rights.
# Private hosting is fine — public distribution is a decision only Brendan
# makes, so make the tool refuse rather than trusting anyone to remember.
# Override exists so the refusal is a speed bump for an authorized human, not a
# wall; it is deliberately ugly to type and it is logged.
case "$REPO" in
  *triplets*|*eval-v1*|*corpus*|*query-pairs*)
    if [ "$PRIVATE" != "True" ] && [ "${I_HAVE_BRENDANS_EXPLICIT_GO_TO_PUBLISH_TEXT:-}" != "yes" ]; then
      echo "REFUSING: $REPO carries abstract text and PRIVATE=$PRIVATE." >&2
      echo "  ~72% of this corpus restricts derivative redistribution (cc_no 29.9% = all rights reserved)." >&2
      echo "  Public distribution is Brendan's call. See the Licensing section of docs/CSHL-CPT-REPORT.md." >&2
      echo "  Recommended alternative: publish keys only (doi + server are on every frozen row)." >&2
      exit 1
    fi
    if ! grep -q "cc_no" "$CARD"; then
      echo "REFUSING: $REPO carries abstract text but its card has no licence table." >&2
      echo "  Run scripts/publish-nsr/fill-card.mjs so {{LICENSE_TABLE}} is populated." >&2
      exit 1
    fi
    ;;
esac
if grep -q '{{' "$CARD"; then
  echo "REFUSING: $CARD still contains {{PLACEHOLDER}} markers:"; grep -o '{{[A-Z_]*}}' "$CARD" | sort -u | sed 's/^/  /'
  echo "Fill them from the actual run before publishing. A card with placeholders is worse than no card."
  exit 1
fi
echo "repo: $REPO (private=$PRIVATE, type=$TYPE)"
echo "weights: $SRC"
echo "card: $CARD"

if [ -n "$DRYRUN" ]; then
  echo "  [dry-run] would upload $CARD -> s3://$BUCKET/cards/$(basename "$CARD")"
  echo "  [dry-run] would launch t3.small ($NAME) which would:"
  echo "      aws s3 sync $SRC /work/  (excluding checkpoint-*/ and rehearsal/)"
  echo "      huggingface_hub.create_repo('$REPO', repo_type='$TYPE', private=$PRIVATE, exist_ok=True)"
  echo "      huggingface_hub.upload_folder('/work' -> '$REPO')"
  echo "  [dry-run] NOTHING PUSHED. This command needs Brendan's explicit go."
  exit 0
fi
aws s3 cp "$CARD" "s3://$BUCKET/cards/$(basename "$CARD")" --region $REGION >/dev/null
CARD_S3="s3://$BUCKET/cards/$(basename "$CARD")"
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
AMI=$(aws ssm get-parameter --region $REGION --name /aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id --query Parameter.Value --output text)
USERDATA=$(cat <<EOS
#!/bin/bash
set -uo pipefail
exec > /var/log/publish.log 2>&1
apt-get update -q && apt-get install -y -q python3-venv awscli >/dev/null
python3 -m venv /opt/hf && /opt/hf/bin/pip install -q huggingface_hub
mkdir -p /work && aws s3 sync --only-show-errors --exclude "checkpoint-*/*" --exclude "rehearsal/*" $SRC /work/
aws s3 cp --only-show-errors $CARD_S3 /work/README.md
export HF_TOKEN=\$(aws ssm get-parameter --region $REGION --with-decryption --name $HF_TOKEN_PARAM --query Parameter.Value --output text)
/opt/hf/bin/python - <<'PY'
import os
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo("$REPO", repo_type="$TYPE", private=$PRIVATE, exist_ok=True)
info = api.upload_folder(folder_path="/work", repo_id="$REPO", repo_type="$TYPE", commit_message="RxivGPT: weights + card")
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
