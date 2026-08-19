#!/usr/bin/env bash
# Attach (or replace) the reranker container on a running nsr-serve box via SSM.
#   usage: RR_RUN=<run-id> INSTANCE=<i-...> ./scripts/serve-nsr/attach-reranker.sh
set -euo pipefail
REGION=us-east-1; BUCKET=nsr-embed-v2
RR_RUN=${RR_RUN:?}; INSTANCE=${INSTANCE:?}
TMP=$(mktemp)
python3 - "$RR_RUN" "$REGION" "$BUCKET" > "$TMP" <<'PY'
import json, sys
run, region, bucket = sys.argv[1:4]
cmd = f'''set -e
mkdir -p /models/rr
aws s3 sync --only-show-errors s3://{bucket}/models/nsr-reranker-gte-modernbert/{run}/final /models/rr
KEY=$(aws ssm get-parameter --region {region} --with-decryption --name /nsr/serve/api-key --query Parameter.Value --output text)
docker rm -f tei-rr >/dev/null 2>&1 || true
docker run -d --restart unless-stopped -p 8081:80 -v /models/rr:/data/model --name tei-rr ghcr.io/huggingface/text-embeddings-inference:cpu-1.8 --model-id /data/model --api-key "$KEY" --max-client-batch-size 64 --max-batch-tokens 4096 --max-batch-requests 8 --auto-truncate
for t in $(seq 1 90); do curl -sf http://127.0.0.1:8081/health && echo RERANKER-READY && exit 0; sleep 5; done
echo RERANKER-NOT-READY; exit 1'''
print(json.dumps({"commands": cmd.split("\n")}))
PY
ID=$(aws ssm send-command --region $REGION --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --parameters "file://$TMP" --timeout-seconds 900 --query 'Command.CommandId' --output text)
rm -f "$TMP"; echo "ssm command: $ID"
for i in $(seq 1 120); do
  ST=$(aws ssm get-command-invocation --region $REGION --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 5
done
aws ssm get-command-invocation --region $REGION --command-id "$ID" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -6
