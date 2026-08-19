#!/usr/bin/env bash
# Upload a converted training slice (train.jsonl + manifest.json) to S3 for the
# train rig to pull. Ported from scripts/train-nsr/upload-slice.sh at 8c1b05b;
# changed only in that the manifest travels WITH the slice — train.sh refuses to
# train on a set whose manifest does not assert disjointness.pass.
#   usage: NAME=full ./scripts/train/upload-slice.sh
set -euo pipefail
REGION=${REGION:-us-east-1}
BUCKET=${BUCKET:-cshl-embed-rxiv}
NAME=${NAME:?set NAME (data/train/<NAME>/train.jsonl)}
SRC=${SRC:-data/train/$NAME}
DRYRUN=${DRYRUN:-}
[ -f "$SRC/train.jsonl" ] || { echo "$SRC/train.jsonl not found — run scripts/train/to-flag.mjs first"; exit 1; }
[ -f "$SRC/manifest.json" ] || { echo "$SRC/manifest.json not found — train.sh will refuse the slice"; exit 1; }
python3 -c "
import json,sys
d=json.load(open('$SRC/manifest.json')).get('disjointness',{})
print('disjointness:', json.dumps(d)); sys.exit(0 if d.get('pass') is True else 1)" \
  || { echo "manifest disjointness.pass != true — not uploading"; exit 1; }
echo "pairs: $(wc -l < "$SRC/train.jsonl")"
if [ -n "$DRYRUN" ]; then
  echo "  [dry-run] would upload $SRC/{train.jsonl,manifest.json} -> s3://$BUCKET/train/$NAME/"; exit 0
fi
aws s3 cp "$SRC/train.jsonl"    "s3://$BUCKET/train/$NAME/train.jsonl"    --region $REGION
aws s3 cp "$SRC/manifest.json"  "s3://$BUCKET/train/$NAME/manifest.json"  --region $REGION
EVAL_VERSION=${EVAL_VERSION:-cshl-eval-v1}
if [ -f "data/eval/$EVAL_VERSION/queries.jsonl" ]; then
  aws s3 cp "data/eval/$EVAL_VERSION/queries.jsonl" "s3://$BUCKET/eval/$EVAL_VERSION/queries.jsonl" --region $REGION
  echo "uploaded frozen queries for $EVAL_VERSION (the train box embeds them with the fresh checkpoint)"
else
  echo "NOTE: data/eval/$EVAL_VERSION/queries.jsonl absent - train box will skip the query embed"
fi
echo "uploaded s3://$BUCKET/train/$NAME/"
