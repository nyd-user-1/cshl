#!/bin/bash
# LANE-LIBRARIAN box-side driver. Ported from scripts/train/train.sh — same
# environment facts, same checkpoint discipline, same upload-early rule.
#
# Inherited verbatim from scripts/train/train.sh's header (same AMI, so these
# were paid for once already and are not re-derived):
#   1. Python with torch is /opt/pytorch/bin/python3 (3.12 venv), NOT /usr/bin/python3.
#   2. transformer_engine dlopens libcudnn_graph.so.9 from site-packages/nvidia/*/lib,
#      which is not on the loader path. LD_LIBRARY_PATH must include every one.
#
# ORDER IS DELIBERATE:
#   smoke -> category(train,score) -> UPLOAD -> mesh(train,score) -> UPLOAD ->
#   baselines -> infer -> UPLOAD
# Weights upload the moment a task finishes, never at the end: NSR's reranker box
# terminated with a clean training run and no weights because the upload was last
# (train.sh §6). And the smoke stage runs the ENTIRE pipeline at toy scale first,
# so a broken run costs ~3 minutes rather than the whole box — the cheap insurance
# an unattended overnight needs.
set -euo pipefail
: "${RUN_ID:?}" "${BUCKET:?}"
BASE_MODEL=${BASE_MODEL:-answerdotai/ModernBERT-base}
MAX_LEN=${MAX_LEN:-1024}
BATCH=${BATCH:-32}
CAT_EPOCHS=${CAT_EPOCHS:-2}
MESH_EPOCHS=${MESH_EPOCHS:-3}
LR=${LR:-3e-5}
SAVE_STEPS=${SAVE_STEPS:-500}
CKPT_SYNC_INTERVAL=${CKPT_SYNC_INTERVAL:-120}
SKIP_SMOKE=${SKIP_SMOKE:-0}
ONLY_TASK=${ONLY_TASK:-}
S3="s3://$BUCKET/models/cshl-classify/$RUN_ID"
D=/opt/classify
PY=/opt/pytorch/bin/python3
SP=/opt/pytorch/lib/python3.12/site-packages
export LD_LIBRARY_PATH="$(find "$SP/nvidia" -maxdepth 2 -type d -name lib 2>/dev/null | tr '\n' ':')"
export HF_HOME=$D/hf-cache TOKENIZERS_PARALLELISM=false

mkdir -p $D/data $D/out
cd $D

echo "[run.sh] RUN_ID=$RUN_ID base=$BASE_MODEL max_len=$MAX_LEN batch=$BATCH cat_epochs=$CAT_EPOCHS mesh_epochs=$MESH_EPOCHS"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true

# 1. deps. transformers>=4.48 is REQUIRED for ModernBERT (the architecture did not
#    exist before it); assert rather than hope, because a silent fallback here would
#    surface as an unrecognised-model error 40 minutes into the run.
$PY -m pip install -q -U "transformers>=4.48,<5" "accelerate>=0.34" psycopg2-binary 2>&1 | tail -5
$PY - <<'PYV'
import transformers, sys
from packaging.version import Version
v = transformers.__version__
print(f"[run.sh] transformers {v}")
assert Version(v.split('.dev')[0]) >= Version("4.48"), f"transformers {v} predates ModernBERT"
PYV

# 2. pull slices + worker
aws s3 cp "s3://$BUCKET/classify/$RUN_ID/classify.py" $D/classify.py
for f in category.labels.json mesh.labels.json slices-manifest.json \
         category.train.jsonl category.val.jsonl category.test.jsonl category.eval.jsonl \
         mesh.train.jsonl mesh.val.jsonl mesh.test.jsonl mesh.eval.jsonl mesh.infer.jsonl; do
  aws s3 cp "s3://$BUCKET/classify/$RUN_ID/data/$f" "$D/data/$f" --only-show-errors
done

# 3. THE GATE the box refuses to train without (train.sh's manifest gate, same shape):
#    never train on a set whose manifest does not assert disjointness from the holdout.
$PY - <<'PYG'
import json, sys
m = json.load(open('/opt/classify/data/slices-manifest.json'))
d = m.get('disjointness', {})
print('[run.sh] manifest disjointness:', json.dumps(d))
print('[run.sh] manifest problems:', m.get('problems'))
sys.exit(0 if d.get('pass') is True and not m.get('problems') else 1)
PYG
[ $? -eq 0 ] || { echo "[run.sh] slices manifest failed its own gate — refusing to train"; exit 1; }

# 4. background checkpoint syncer — what makes SAVE_STEPS protective rather than
#    a local-only safety net (the box's disk dies with the box).
( while true; do sleep "$CKPT_SYNC_INTERVAL"
    aws s3 sync $D/out "$S3/checkpoints/" --exclude '*' --include '*/checkpoint-*/**' --only-show-errors 2>/dev/null || true
  done ) & SYNC_PID=$!
trap 'kill $SYNC_PID 2>/dev/null || true' EXIT

upload() {  # upload(task) — weights + scores, immediately, never deferred
  aws s3 cp --recursive "$D/out/$1/final" "$S3/$1/final/" --only-show-errors || true
  aws s3 cp "$D/out/$1.scores.json" "$S3/$1.scores.json" --only-show-errors 2>/dev/null || true
  echo "[run.sh] uploaded $1 -> $S3/$1/"
}

# 5. SMOKE: the whole pipeline at toy scale before any real money is spent.
if [ "$SKIP_SMOKE" != 1 ]; then
  echo "[run.sh] ===== SMOKE ====="
  T0=$(date +%s)
  for t in category mesh; do
    $PY classify.py train --task $t --data $D/data --out $D/smoke/$t --base "$BASE_MODEL" \
      --cache $D/hf-cache --max-len 256 --batch 8 --epochs 1 --limit 200 --save-steps 100000
    $PY classify.py score --task $t --data $D/data --out $D/smoke --model $D/smoke/$t/final \
      --batch 8 --limit 100
  done
  $PY classify.py infer --task mesh --data $D/data --out $D/smoke --model $D/smoke/mesh/final \
    --batch 8 --limit 100
  echo "[run.sh] SMOKE PASSED in $(( $(date +%s) - T0 ))s — proceeding to the real run"
  rm -rf $D/smoke
fi

# 6. the real runs
# train_with_oom_retry(task, epochs, resume) -- ported from train.sh's OOM loop. The
# fallback types in TYPE_MENU (g5/g6.2xlarge) carry 24 GB, not the L40S's 48 GB, so a
# batch that fits the preferred box may not fit the one we actually got. Halve rather
# than die: an unattended run that OOMs at 02:00 and stops has wasted the whole box.
train_with_oom_retry() {
  local task=$1 epochs=$2 resume=$3 b=$BATCH gc=""
  while true; do
    echo "[run.sh] train $task: batch=$b epochs=$epochs gradient_checkpointing=${gc:-off}"
    set +e
    $PY classify.py train --task $task --data $D/data --out $D/out/$task --base "$BASE_MODEL" \
      --cache $D/hf-cache --max-len $MAX_LEN --batch $b --epochs $epochs --lr $LR \
      --save-steps $SAVE_STEPS ${resume:+--resume $resume} 2>&1 | tee $D/out/$task.train.log
    local rc=${PIPESTATUS[0]}
    set -e
    [ "$rc" -eq 0 ] && { echo "[run.sh] train $task OK at batch=$b"; return 0; }
    if grep -qiE "out of memory|CUDA error: out of memory|OutOfMemoryError" $D/out/$task.train.log; then
      if [ "$b" -le 4 ]; then echo "[run.sh] OOM at batch=4 — giving up on $task"; return 1; fi
      b=$((b / 2)); echo "[run.sh] OOM — halving batch to $b"; continue
    fi
    echo "[run.sh] train $task failed (non-OOM, rc=$rc)"; return "$rc"
  done
}

if [ -z "$ONLY_TASK" ] || [ "$ONLY_TASK" = category ]; then
  echo "[run.sh] ===== cshl-category ====="
  train_with_oom_retry category "$CAT_EPOCHS" "${RESUME_CATEGORY:-}"
  $PY classify.py score --task category --data $D/data --out $D/out --model $D/out/category/final --batch $((BATCH*2))
  upload category
fi

if [ -z "$ONLY_TASK" ] || [ "$ONLY_TASK" = mesh ]; then
  echo "[run.sh] ===== cshl-MESH-tagger ====="
  train_with_oom_retry mesh "$MESH_EPOCHS" "${RESUME_MESH:-}"
  $PY classify.py score --task mesh --data $D/data --out $D/out --model $D/out/mesh/final --batch $((BATCH*2))
  upload mesh
fi

# 7. baselines. The prior baseline needs nothing; the kNN baseline needs the stock
#    bge-m3 vectors and is the one that decides whether these models are worth serving.
echo "[run.sh] ===== baselines ====="
for t in category mesh; do
  $PY classify.py baseline --task $t --data $D/data --out $D/out || echo "[run.sh] prior baseline $t FAILED (non-fatal)"
  $PY classify.py knn --task $t --data $D/data --out $D/out || echo "[run.sh] kNN baseline $t FAILED (non-fatal)"
done
aws s3 cp $D/out "$S3/" --recursive --exclude '*' --include '*.json' --only-show-errors || true

# 8. the room map's input: tag the corpus rows with no observed MeSH
echo "[run.sh] ===== infer (room map input) ====="
$PY classify.py infer --task mesh --data $D/data --out $D/out --model $D/out/mesh/final \
  --batch $((BATCH*2)) --top-k ${TOP_K:-20} --threshold ${THRESHOLD:-0.5}
gzip -f $D/out/mesh.predictions.jsonl
aws s3 cp $D/out/mesh.predictions.jsonl.gz "$S3/mesh.predictions.jsonl.gz"

kill $SYNC_PID 2>/dev/null || true
aws s3 cp $D/out "$S3/" --recursive --exclude '*' --include '*.json' --only-show-errors || true
echo "[run.sh] ALL DONE. artifacts: $S3/"
