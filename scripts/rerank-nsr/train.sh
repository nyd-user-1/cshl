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
CKPT_STEPS=${CKPT_STEPS:-1000}
CKPT_SYNC_INTERVAL=${CKPT_SYNC_INTERVAL:-240}
RESUME=${RESUME:-0}
CKPT_S3="s3://$BUCKET/models/cshl-reranker-gte-modernbert/$RUN_ID/checkpoint/"

# 3a. Checkpoint durability (LANE-RERANK G3). train.py has always checkpointed
#     (--ckpt-steps, --resume, and a checkpointing wall-clock kill), but this
#     box runs with instance-initiated-shutdown-behavior=terminate on a
#     delete-on-termination volume: a checkpoint on local EBS is not a
#     checkpoint. A killed run lost everything, not ≤10 min. Two changes:
#     --ckpt-steps is now passed explicitly (default 1000 ≈ 4.4 min at the
#     measured ~3.75 steps/s, not train.py's 2000 ≈ 8.9 min), and a background
#     loop mirrors the checkpoint dir to S3 every CKPT_SYNC_INTERVAL seconds.
#     Worst-case loss = ckpt interval + sync lag ≈ 8.4 min.
if [ "$RESUME" = 1 ]; then
  echo "[train.sh] RESUME=1 — pulling any prior checkpoint from $CKPT_S3"
  aws s3 cp --only-show-errors --recursive "$CKPT_S3" "$DIR/model/checkpoint/" || \
    echo "[train.sh] no prior checkpoint at $CKPT_S3 — starting fresh"
fi

#     train.py:205-212 writes the weights first and `state.json` LAST, so
#     state.json is the completion marker. The mirror copies everything EXCEPT
#     state.json, re-reads the local step, and only uploads state.json if the
#     step did not move while the copy was in flight — otherwise a save that
#     landed mid-sync would publish a half-written model under a marker that
#     claims it is whole. On a mismatch nothing is committed and the next cycle
#     retries. (Note: train.py saves model weights + epoch/step, NOT optimizer
#     state; a resume restarts AdamW cold. That is 44b's design and train.py
#     runs unchanged.)
ckpt_step() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['step'])" "$1" 2>/dev/null || echo x; }
ckpt_sync_loop() {
  while true; do
    sleep "$CKPT_SYNC_INTERVAL"
    LOCAL_STATE="$DIR/model/checkpoint/state.json"
    [ -f "$LOCAL_STATE" ] || continue
    BEFORE=$(ckpt_step "$LOCAL_STATE")
    if aws s3 sync --only-show-errors --delete --exclude state.json \
         "$DIR/model/checkpoint/" "$CKPT_S3"; then
      AFTER=$(ckpt_step "$LOCAL_STATE")
      if [ "$BEFORE" = "$AFTER" ] && [ "$BEFORE" != x ]; then
        aws s3 cp --only-show-errors "$LOCAL_STATE" "${CKPT_S3}state.json" \
          && echo "[ckpt-sync] $(date -u +%H:%M:%S) committed step $AFTER" \
          || echo "[ckpt-sync] $(date -u +%H:%M:%S) marker upload failed — not committed"
      else
        echo "[ckpt-sync] $(date -u +%H:%M:%S) save landed mid-sync ($BEFORE -> $AFTER) — not committed, retrying next cycle"
      fi
    else
      echo "[ckpt-sync] $(date -u +%H:%M:%S) sync FAILED (training continues)"
    fi
  done
}
ckpt_sync_loop &
CKPT_SYNC_PID=$!
trap 'kill $CKPT_SYNC_PID 2>/dev/null || true' EXIT
echo "[train.sh] ckpt-sync started (pid $CKPT_SYNC_PID, every ${CKPT_SYNC_INTERVAL}s -> $CKPT_S3)"

T0=$(date +%s)
python3 /opt/reranker/train.py \
  --dir "$DIR" \
  --base Alibaba-NLP/gte-reranker-modernbert-base \
  --epochs "$EPOCHS" \
  --bulk 0 \
  --max-hours "$MAXHOURS" \
  --ckpt-steps "$CKPT_STEPS" \
  $([ "$RESUME" = 1 ] && echo --resume) \
  2>&1 | tee "$DIR/train.log"
EXIT=${PIPESTATUS[0]}
T1=$(date +%s)
kill $CKPT_SYNC_PID 2>/dev/null || true
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
    # BUG FIXED (cshl-RR run 20260819-223601): train.py resets `step` to 0 at
    # every epoch boundary, so (last_step - first_step) counts ONE epoch's steps
    # while (t1 - t0) spans ALL of them. The old two-point form under-reported
    # throughput by exactly a factor of EPOCHS — it called 3.94 steps/s "1.978"
    # and then projected 126 min for work that takes 63. Count epochs properly.
    def parse_ep(l):
        m = re.search(r'epoch (\d+) step (\d+)/(\d+)', l)
        return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None
    eps = [parse_ep(l) for l in lines]
    eps = [e for e in eps if e]
    t0, s0 = parse(lines[0]); t1, s1 = parse(lines[-1])
    if eps:
        spe = eps[-1][2]
        g0 = eps[0][0] * spe + eps[0][1]
        g1 = eps[-1][0] * spe + eps[-1][1]
        steps_per_s = (g1 - g0) / (t1 - t0) if t1 > t0 else float('nan')
    else:
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
aws s3 cp --only-show-errors --recursive "$DIR/model/final" "s3://$BUCKET/models/cshl-reranker-gte-modernbert/$RUN_ID/final/"
aws s3 cp --only-show-errors --recursive "$DIR/model" "s3://$BUCKET/models/cshl-reranker-gte-modernbert/$RUN_ID/" || true
[ -f "/opt/reranker/reranked-$RUN_ID.json" ] && aws s3 cp --only-show-errors "/opt/reranker/reranked-$RUN_ID.json" "s3://$BUCKET/models/cshl-reranker-gte-modernbert/$RUN_ID/reranked-$RUN_ID.json" || true
aws s3 cp --only-show-errors "$DIR/train.log" "s3://$BUCKET/logs/cshl-reranker-$RUN_ID-inner.log" || true
echo "[train.sh] done. weights: s3://$BUCKET/models/cshl-reranker-gte-modernbert/$RUN_ID/final/"
