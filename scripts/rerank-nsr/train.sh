#!/bin/bash
# rerank rig box-side script (CSHL / RxivGPT) — ported from the NSR rig at
# 8c1b05b. CHANGED: model/bucket names; the on-box scoring step is removed (see
# §5) so no DB credential reaches this box; train.py still runs UNCHANGED.
# original header follows.
# rerank-nsr box-side script — runs on the g6e.xlarge EC2 box launched by
# launch.sh. Runs 44b's train.py UNCHANGED (LANE-RERANK non-negotiable #2:
# "train.py runs unchanged, path flags only") against a pre-mined
# train-groups.jsonl pulled from S3 — train.py:68/175 skips its own BM25
# miner whenever `<dir>/train-groups.jsonl` already exists, which is how our
# bge-m3-mined negatives (not a fresh --retriever mine) reach the GPU.
# MODE=train only: scores `final/` against LANE-EVAL's frozen benchmark
# before shutdown (same box, one boot).
set -euo pipefail
: "${MODE:?}" "${TRAIN_NAME:?}" "${RUN_ID:?}" "${BUCKET:?}"
echo "[train.sh] MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID"

# 1. Install deps. train.py's mining path (scipy/sentence_transformers) is
#    dead code here because train-groups.jsonl already exists on disk before
#    train.py ever runs (step 3 below) — only torch and transformers are
#    actually imported. (NSR also installed psycopg2 for its on-box scoring
#    step; that step is gone — see §5.)
#    Correction to LANE-RERANK non-negotiable #1's claim ("torch/CUDA/python
#    preinstalled"): attempt 1 hit `ModuleNotFoundError: No module named
#    'torch'` — this DLAMI does NOT ship torch as a host python3 package
#    (LANE-TRAIN independently found the same thing tonight for this same
#    AMI: "this DLAMI does not ship torch as a host Python package at all").
#    Installing it explicitly; a fresh ~2GB download every boot, unavoidable.
pip install -U torch transformers 2>&1 | tail -60

# 2. Pull train.py (unchanged) + the pre-converted groups
DIR=/opt/reranker/run
mkdir -p "$DIR"
aws s3 cp "s3://$BUCKET/reranker/train.py" /opt/reranker/train.py
aws s3 cp "s3://$BUCKET/reranker/train/$TRAIN_NAME/train-groups.jsonl" "$DIR/train-groups.jsonl"
N_GROUPS=$(wc -l < "$DIR/train-groups.jsonl")
echo "[train.sh] $N_GROUPS groups in $TRAIN_NAME -> $DIR/train-groups.jsonl"

# 3. Train — non-negotiable #2's exact flags. --bulk 0 disables 44b's
#    title<->abstract self-supervision (not our signal). Epochs/max-hours
#    differ rehearse vs train.
EPOCHS=${EPOCHS:-1}
MAXHOURS=${MAXHOURS:-0.5}
T0=$(date +%s)
python3 /opt/reranker/train.py \
  --dir "$DIR" \
  --base Alibaba-NLP/gte-reranker-modernbert-base \
  --epochs "$EPOCHS" \
  --bulk 0 \
  --max-hours "$MAXHOURS" \
  2>&1 | tee "$DIR/train.log"
EXIT=${PIPESTATUS[0]}
T1=$(date +%s)
echo "[train.sh] train.py EXIT=$EXIT wall-clock=$((T1 - T0))s"
[ "$EXIT" -eq 0 ] || { echo "[train.sh] training failed — not proceeding"; exit "$EXIT"; }

# groups/s from the log's own timestamps (first vs last logged step).
python3 - "$DIR/train.log" "$N_GROUPS" "$EPOCHS" <<'PY'
import re, sys
log, n_groups, epochs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
lines = [l for l in open(log) if 'step' in l and 'loss' in l]
if len(lines) >= 2:
    def parse(l):
        t = float(re.match(r'\[\s*([\d.]+)s\]', l).group(1))
        step = int(re.search(r'step (\d+)/', l).group(1))
        return t, step
    t0, s0 = parse(lines[0]); t1, s1 = parse(lines[-1])
    steps_per_s = (s1 - s0) / (t1 - t0) if t1 > t0 else float('nan')
    groups_per_s = steps_per_s * 8  # groups_per_batch=8 (train.py default)
    print(f"[train.sh] measured: {steps_per_s:.3f} steps/s -> {groups_per_s:.2f} groups/s (batch=8)")
    full = 60000
    proj_s = (full * epochs) / groups_per_s if groups_per_s == groups_per_s else float('nan')
    print(f"[train.sh] projection: {full} groups x {epochs} epoch(s) at this rate -> {proj_s:.0f}s ({proj_s/60:.1f} min)")
else:
    print("[train.sh] not enough log lines to measure groups/s")
PY

# 4. Model saves and loads — sanity check, not asked for by rehearsal alone
#    but cheap and catches a corrupt save before it costs a real run.
python3 - "$DIR/model/final" <<'PY'
import sys
from transformers import AutoTokenizer, AutoModelForSequenceClassification
p = sys.argv[1]
tok = AutoTokenizer.from_pretrained(p)
model = AutoModelForSequenceClassification.from_pretrained(p)
enc = tok(["test query"], ["test document"], return_tensors="pt")
out = model(**enc).logits
print(f"[train.sh] model saved+loaded OK from {p}, sanity logit={out.item():.4f}")
PY

# 5. Scoring is NOT done on this box. NSR ran the frozen benchmark here, which
#    meant shipping DATABASE_URL to the trainer and re-implementing retrieval in
#    a heredoc against nsr_eval_queries/nsr_embeddings. Neither table exists in
#    CSHL and neither should: scripts/eval/score.mjs now scores a reranker as a
#    composite arm against a serving endpoint —
#      ARMS=bge-m3,rerank:bge-m3@http://<serve-ip>:8081 node scripts/eval/score.mjs
#    so the reranker box carries no database credential at all.

# 6. Upload weights FIRST (the run's only durable artifact), then results/logs.
#    2026-08-17 03:15: the results upload (denied prefix) ran before the weights
#    upload under set -e and the box self-terminated with the trained model on
#    a delete-on-termination volume — 43 GPU-minutes lost. Never again: weights
#    go up first, everything after is `|| true`.
aws s3 cp --only-show-errors --recursive "$DIR/model/final" "s3://$BUCKET/models/rxiv-reranker-gte-modernbert/$RUN_ID/final/"
aws s3 cp --only-show-errors --recursive "$DIR/model" "s3://$BUCKET/models/rxiv-reranker-gte-modernbert/$RUN_ID/" || true
[ -f "/opt/reranker/reranked-$RUN_ID.json" ] && aws s3 cp --only-show-errors "/opt/reranker/reranked-$RUN_ID.json" "s3://$BUCKET/models/rxiv-reranker-gte-modernbert/$RUN_ID/reranked-$RUN_ID.json" || true
aws s3 cp --only-show-errors "$DIR/train.log" "s3://$BUCKET/logs/cshl-reranker-$RUN_ID-inner.log" || true
echo "[train.sh] done. weights: s3://$BUCKET/models/rxiv-reranker-gte-modernbert/$RUN_ID/final/"
