#!/bin/bash
# Upload the built slices for a RUN_ID. Separate from launch.sh so a relaunch
# (resume, retry) does not re-push ~1 GB of jsonl.
set -euo pipefail
BUCKET=${BUCKET:-cshl-embed-rxiv}
RUN_ID=${RUN_ID:?set RUN_ID}
D=data/classify
for f in category.labels.json mesh.labels.json slices-manifest.json \
         category.train.jsonl category.val.jsonl category.test.jsonl category.eval.jsonl \
         mesh.train.jsonl mesh.val.jsonl mesh.test.jsonl mesh.eval.jsonl mesh.infer.jsonl; do
  [ -f "$D/$f" ] || { echo "missing $D/$f — run scripts/classify/build-slices.py"; exit 1; }
  aws s3 cp "$D/$f" "s3://$BUCKET/classify/$RUN_ID/data/$f" --only-show-errors
  echo "  up: $f ($(du -h "$D/$f" | cut -f1))"
done
echo "slices at s3://$BUCKET/classify/$RUN_ID/data/"
