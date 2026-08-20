#!/usr/bin/env bash
# Ephemeral HF publisher (CSHL / RxivGPT) — a t3.small pulls <S3 final dir> +
# a card, pushes to a private HF repo, uploads its log, terminates.
# Ported from scripts/publish-nsr/launch.sh at 8c1b05b.
#
# CHANGED vs the NSR original:
#   - CARD is now a LOCAL path under scripts/publish-nsr/cards/ that this script
#     uploads for you. NSR required you to have already put the card in S3 by
#     hand, which is how a model ships with a stale card.
#   - names/bucket/SSM parameterized; HF_TOKEN_PARAM is RESOLVED (/cshl/hf/token
#     then /nsr/hf/token), on the laptop, and the role is granted read on it.
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
HF_TOKEN_PARAM=${HF_TOKEN_PARAM:-}
SRC=${SRC:?set SRC=s3://.../final/}
REPO=${REPO:?set REPO=NYSgpt/<name>}
CARD=${CARD:?set CARD=scripts/publish-nsr/cards/<name>.md}
TYPE=${TYPE:-model}
PRIVATE=${PRIVATE:-True}
DRYRUN=${DRYRUN:-}
NAME=cshl-publish-$(echo "$REPO" | tr '/' '-')
[ -f "$CARD" ] || { echo "card not found: $CARD"; exit 1; }

# PRIVATE-ONLY GUARD (universal). This used to live inside the text-bearing case
# below, which meant it only fired on repo names matching *triplets*/*eval-v1*/
# *corpus*/*query-pairs*. A model repo — `cshl-encoder-bge-m3-qpairs`, say, where
# `qpairs` does not match `query-pairs` — could be pushed with PRIVATE=False and
# the tool would not object. Standing policy is PRIVATE ONLY for everything in
# this program, so the refusal is now universal and the name-matched case below
# only adds the *extra* licence-table requirement that text-bearing repos need.
if [ "$PRIVATE" != "True" ] && [ "${I_HAVE_BRENDANS_EXPLICIT_GO_TO_PUBLISH_TEXT:-}" != "yes" ]; then
  echo "REFUSING: PRIVATE=$PRIVATE for $REPO. Standing policy for this program is private only." >&2
  echo "  Weights are derived from a corpus that is ~72% licence-restricted; see the Licensing" >&2
  echo "  section of docs/CSHL-CPT-REPORT.md. Going public is Brendan's call, not a flag." >&2
  exit 1
fi

# TEXT-BEARING ARTIFACT GUARD. `*qpairs*` joined the pattern list because the
# 424,753-row query-pairs set inlines abstracts exactly the way the triplets do,
# and the short name is the one anyone would reach for when publishing it.
# cshl-triplets and cshl-eval-v1 inline abstract
# text; ~72% of this corpus carries a licence restricting derivative
# redistribution or commercial use, and `cc_no` (29.9%) reserves all rights.
# Private hosting is fine — public distribution is a decision only Brendan
# makes, so make the tool refuse rather than trusting anyone to remember.
# Override exists so the refusal is a speed bump for an authorized human, not a
# wall; it is deliberately ugly to type and it is logged.
case "$REPO" in
  *triplets*|*eval-v1*|*corpus*|*query-pairs*|*qpairs*)
    if ! grep -q "cc_no" "$CARD"; then
      echo "REFUSING: $REPO carries abstract text but its card has no licence table." >&2
      echo "  Run scripts/publish-nsr/fill-card.mjs so {{LICENSE_TABLE}} is populated." >&2
      exit 1
    fi
    ;;
esac
# Placeholders are {{UPPER_SNAKE}} — that is the shape fill-card.mjs writes and the
# shape this refusal prints. It used to test for a bare `{{`, which also matched the
# literal "{{...}}" inside the maintainer comment that every card in this program
# carries: every existing card was unpublishable, and the refusal printed an EMPTY
# list of offenders because the list is built with the narrow pattern. A guard that
# refuses without naming a reason gets worked around instead of read.
UNFILLED=$(grep -o '{{[A-Z_]\+}}' "$CARD" | sort -u)
if [ -n "$UNFILLED" ]; then
  echo "REFUSING: $CARD still contains {{PLACEHOLDER}} markers:"; echo "$UNFILLED" | sed 's/^/  /'
  echo "Fill them from the actual run before publishing. A card with placeholders is worse than no card."
  exit 1
fi

# HF TOKEN RESOLUTION — the fallback this file's header has always claimed and
# never implemented. The default used to be a hard `/cshl/hf/token`, a parameter
# that does not exist in this account; the box would fetch nothing, `set -uo
# pipefail` (no -e) would carry on, create_repo would raise, and the script's
# unconditional `echo PUBLISH-DONE` would report a clean run over an empty Hub.
# Resolve it HERE, on the laptop, where a failure is visible and free.
if [ -z "$HF_TOKEN_PARAM" ]; then
  for cand in /cshl/hf/token /nsr/hf/token; do
    if aws ssm get-parameter --region $REGION --name "$cand" >/dev/null 2>&1; then HF_TOKEN_PARAM=$cand; break; fi
  done
fi
[ -n "$HF_TOKEN_PARAM" ] || { echo "REFUSING: no HF token parameter found (/cshl/hf/token, /nsr/hf/token)." >&2; exit 1; }
aws ssm get-parameter --region $REGION --name "$HF_TOKEN_PARAM" >/dev/null 2>&1 || {
  echo "REFUSING: HF_TOKEN_PARAM=$HF_TOKEN_PARAM is not readable." >&2; exit 1; }

echo "repo: $REPO (private=$PRIVATE, type=$TYPE)"
echo "weights: $SRC"
echo "card: $CARD"
echo "hf token: $HF_TOKEN_PARAM"

if [ -n "$DRYRUN" ]; then
  echo "  [dry-run] would upload $CARD -> s3://$BUCKET/cards/$(basename "$CARD")"
  echo "  [dry-run] would launch t3.small ($NAME) which would:"
  echo "      aws s3 sync $SRC /work/  (excluding checkpoint-*/ and rehearsal/)"
  echo "      huggingface_hub.create_repo('$REPO', repo_type='$TYPE', private=$PRIVATE, exist_ok=True)"
  echo "      huggingface_hub.upload_folder('/work' -> '$REPO')"
  echo "  [dry-run] NOTHING PUSHED. This command needs Brendan's explicit go."
  exit 0
fi
# The publish box reads the token through the instance role, so the role needs a
# grant for whichever parameter we just resolved. This is its own inline policy
# name on purpose: `aws iam put-role-policy` replaces a policy by NAME, and the
# train rig re-puts ITS policy on every launch — which is how the qpairs lane lost
# a verified `eval/*` grant mid-run. A separate name cannot be clobbered that way.
aws iam put-role-policy --role-name $ROLE --policy-name read-hf-token --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$HF_TOKEN_PARAM\"}]}"
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
# Every step below is checked. This block used to end in an unconditional
# \`echo PUBLISH-DONE\`, so a failed token fetch or a failed upload still printed
# the success line and then terminated the box that held the evidence.
export HF_TOKEN=\$(aws ssm get-parameter --region $REGION --with-decryption --name $HF_TOKEN_PARAM --query Parameter.Value --output text)
if [ -z "\$HF_TOKEN" ]; then echo "PUBLISH-FAILED: empty HF_TOKEN from $HF_TOKEN_PARAM"; aws s3 cp /var/log/publish.log s3://$BUCKET/logs/$NAME-\$(date +%s).log; shutdown -h now; exit 1; fi
ls -la /work/ && du -sb /work/
/opt/hf/bin/python - <<'PY'
import os
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo("$REPO", repo_type="$TYPE", private=$PRIVATE, exist_ok=True)
info = api.upload_folder(folder_path="/work", repo_id="$REPO", repo_type="$TYPE", commit_message="RxivGPT: weights + card")
print("UPLOADED", "$REPO", getattr(info, "commit_url", info))
# The box's own read-back. It is NOT the verification of record — the lane lists
# the repo through the API from outside — but it means a partial upload is named
# in the log rather than inferred later from a missing file.
files = api.list_repo_files("$REPO", repo_type="$TYPE")
print("REPO-FILES", len(files))
for f in sorted(files): print("  ", f)
PY
rc=\$?
if [ \$rc -ne 0 ]; then echo "PUBLISH-FAILED: python exited \$rc"; else echo PUBLISH-DONE; fi
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
