#!/bin/bash
# Sync a locally-converted FlagEmbedding jsonl to s3://nsr-embed-v2/train/<name>/
# so a train-nsr box can pull it. DB/S3-only, laptop-safe.
# Usage: ./scripts/train-nsr/upload-slice.sh <local.jsonl> <name>
#   e.g. ./scripts/train-nsr/upload-slice.sh /tmp/rehearsal.flag.jsonl rehearsal
set -euo pipefail
BUCKET=nsr-embed-v2
LOCAL=${1:?usage: upload-slice.sh <local.jsonl> <name>}
NAME=${2:?usage: upload-slice.sh <local.jsonl> <name>}
[ -f "$LOCAL" ] || { echo "not found: $LOCAL"; exit 1; }

N=$(wc -l < "$LOCAL")
SIZE=$(du -h "$LOCAL" | cut -f1)
echo "uploading $LOCAL ($N lines, $SIZE) -> s3://$BUCKET/train/$NAME/train.jsonl"
aws s3 cp "$LOCAL" "s3://$BUCKET/train/$NAME/train.jsonl"
aws s3api head-object --bucket $BUCKET --key "train/$NAME/train.jsonl" --query '{size:ContentLength,etag:ETag}'
