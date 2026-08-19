#!/usr/bin/env bash
# Attach (or replace) the reranker container on a running serve box via SSM.
# Ported from the NSR rig at 8c1b05b.
#
# CHANGED vs the NSR original:
#   - RR_ID accepts a HUB id as well as an S3 run — swapping in
#     ncbi/MedCPT-Cross-Encoder is now a one-liner against the live box, which
#     is the cheapest possible rerank A/B (no relaunch, no retrain, no weights).
#   - bucket / model name / SSM key param are env knobs with CSHL defaults.
#   - DRYRUN=1 prints the remote script instead of sending it.
#
#   usage: RR_RUN=<run-id> INSTANCE=<i-...> ./scripts/serve-nsr/attach-reranker.sh
#          RR_ID=ncbi/MedCPT-Cross-Encoder INSTANCE=<i-...> ./scripts/serve-nsr/attach-reranker.sh
set -euo pipefail
REGION=${REGION:-us-east-1}
BUCKET=${BUCKET:-cshl-embed-rxiv}
KEY_PARAM=${KEY_PARAM:-/cshl/serve/api-key}
RR_MODEL_NAME=${RR_MODEL_NAME:-rxiv-reranker-gte-modernbert}
INSTANCE=${INSTANCE:?set INSTANCE=i-...}
RR_RUN=${RR_RUN:-}; RR_ID=${RR_ID:-}
[ -n "$RR_RUN" ] || [ -n "$RR_ID" ] || { echo "set RR_RUN=<run-id> (S3 weights) or RR_ID=<hub id>"; exit 1; }
DRYRUN=${DRYRUN:-}

if [ -n "$RR_RUN" ]; then
  SYNC="aws s3 sync --only-show-errors s3://$BUCKET/models/$RR_MODEL_NAME/$RR_RUN/final /models/rr"
  MOUNT=/models/rr; MODEL_ID=/data
else
  SYNC="true  # hub model, nothing to sync"
  MOUNT=/models/hf; MODEL_ID="$RR_ID"
fi

REMOTE=$(cat <<EOS
set -e
mkdir -p /models/rr /models/hf
$SYNC
KEY=\$(aws ssm get-parameter --region $REGION --with-decryption --name $KEY_PARAM --query Parameter.Value --output text)
docker rm -f tei-rr >/dev/null 2>&1 || true
docker run -d --restart unless-stopped -p 8081:80 -v $MOUNT:/data --name tei-rr ghcr.io/huggingface/text-embeddings-inference:cpu-1.8 --model-id $MODEL_ID --api-key "\$KEY" --max-client-batch-size 64 --max-batch-tokens 4096 --max-batch-requests 8 --auto-truncate
for t in \$(seq 1 90); do curl -sf http://127.0.0.1:8081/health && echo RERANKER-READY && exit 0; sleep 5; done
echo RERANKER-NOT-READY; exit 1
EOS
)
if [ -n "$DRYRUN" ]; then
  echo "───── dry-run: remote script for $INSTANCE ─────"; echo "$REMOTE"; echo "───── end ─────"; exit 0
fi
TMP=$(mktemp)
python3 -c 'import json,sys; print(json.dumps({"commands": sys.stdin.read().split("\n")}))' <<< "$REMOTE" > "$TMP"
ID=$(aws ssm send-command --region $REGION --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --parameters "file://$TMP" --timeout-seconds 900 --query 'Command.CommandId' --output text)
rm -f "$TMP"; echo "ssm command: $ID"
for i in $(seq 1 120); do
  ST=$(aws ssm get-command-invocation --region $REGION --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5
done
aws ssm get-command-invocation --region $REGION --command-id "$ID" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -6
