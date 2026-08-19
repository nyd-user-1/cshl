#!/bin/bash
# rerank-nsr box-side script — runs on the g6e.xlarge EC2 box launched by
# launch.sh. Runs 44b's train.py UNCHANGED (LANE-RERANK non-negotiable #2:
# "train.py runs unchanged, path flags only") against a pre-mined
# train-groups.jsonl pulled from S3 — train.py:68/175 skips its own BM25
# miner whenever `<dir>/train-groups.jsonl` already exists, which is how our
# bge-m3-mined negatives (not a fresh --retriever mine) reach the GPU.
# MODE=train only: scores `final/` against LANE-EVAL's frozen benchmark
# before shutdown (same box, one boot).
set -euo pipefail
: "${MODE:?}" "${TRAIN_NAME:?}" "${RUN_ID:?}" "${BUCKET:?}" "${DATABASE_URL:?}"
echo "[train.sh] MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID"

# 1. Install deps. train.py's mining path (scipy/sentence_transformers) is
#    dead code here because train-groups.jsonl already exists on disk before
#    train.py ever runs (step 3 below) — only torch and transformers are
#    actually imported. psycopg2 only for MODE=train's scoring step.
#    Correction to LANE-RERANK non-negotiable #1's claim ("torch/CUDA/python
#    preinstalled"): attempt 1 hit `ModuleNotFoundError: No module named
#    'torch'` — this DLAMI does NOT ship torch as a host python3 package
#    (LANE-TRAIN independently found the same thing tonight for this same
#    AMI: "this DLAMI does not ship torch as a host Python package at all").
#    Installing it explicitly; a fresh ~2GB download every boot, unavoidable.
pip install -U torch transformers psycopg2-binary 2>&1 | tail -60

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

# 5. MODE=train only: score final/ against LANE-EVAL's frozen benchmark
#    before shutdown. Candidate pools: LANE-EVAL's B.json holds only
#    aggregate metrics (no per-query top-50), so regenerate the Arm-B pool
#    live from nsr_embeddings joined to nsr_eval_queries (both bge-m3,
#    same space LANE-EVAL scored) — same SQL shape as scripts/eval/score.mjs
#    Arm B (SET LOCAL hnsw.ef_search=100, kNN via <=>, LIMIT 50). Written
#    against LANE-EVAL's schema as documented in its REPORT, not a live
#    table at write time — re-verify columns before trusting this block.
if [ "$MODE" = train ]; then
  # Non-fatal: this scoring block is unverified against a live run (written
  # against LANE-EVAL's documented schema, not tested end-to-end before this
  # launch). set -e is active for the whole script — without the `|| echo`,
  # any exception here (a bad column, an OOM on a long query) would abort
  # the script BEFORE step 6 uploads the trained weights, losing the actual
  # deliverable over a scoring bug. Weights matter more than same-boot
  # scoring; if this fails, step 6 still runs and scoring can be re-run
  # separately against the uploaded checkpoint.
  python3 - "$DIR/model/final" "$RUN_ID" <<'PY' || echo "[train.sh] WARNING: Phase 2 scoring failed (non-fatal) — weights still uploading in step 6"
import json, os, time
import numpy as np, psycopg2
import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

MODEL_DIR, RUN_ID = __import__('sys').argv[1], __import__('sys').argv[2]
TOPK = 50
DEV = 'cuda' if torch.cuda.is_available() else 'cpu'
tok = AutoTokenizer.from_pretrained(MODEL_DIR)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR).to(DEV).eval()

def score(query, docs, batch=128, max_len=256):
    out = []
    with torch.inference_mode():
        for s in range(0, len(docs), batch):
            b = docs[s:s + batch]
            enc = tok([query[:600]] * len(b), [d[:900] for d in b], padding=True,
                      truncation=True, max_length=max_len, return_tensors='pt').to(DEV)
            with torch.amp.autocast('cuda', dtype=torch.bfloat16, enabled=(DEV == 'cuda')):
                out.append(model(**enc).logits.float().view(-1).cpu().numpy())
    return np.concatenate(out)

conn = psycopg2.connect(os.environ['DATABASE_URL'])
conn.autocommit = False
rows_out = []
with conn.cursor() as cur:
    cur.execute("SELECT qid, family, text, embedding FROM nsr_eval_queries WHERE embedding IS NOT NULL")
    queries = cur.fetchall()
    print(f"[score] {len(queries)} eval queries")
    t0 = time.time()
    for i, (qid, family, text, qvec) in enumerate(queries):
        cur.execute("BEGIN")
        cur.execute("SET LOCAL hnsw.ef_search = 100")
        cur.execute(
            """SELECT nsr.key_number, coalesce(nsr.title,''), coalesce(nsr.abstract,'')
                 FROM nsr_embeddings e JOIN nsr ON nsr.key_number = e.key_number
                ORDER BY e.embedding <=> %s::vector LIMIT %s""",
            (qvec, TOPK))
        cands = cur.fetchall()
        cur.execute("COMMIT")
        if not cands:
            continue
        docs = [f"{title}. {abstract}" for _, title, abstract in cands]
        s = score(text, docs)
        order = [cands[j][0] for j in np.argsort(-s)]
        raw_order = [c[0] for c in cands]
        rows_out.append({'qid': qid, 'family': family, 'raw_top50': raw_order, 'reranked_top50': order})
        if (i + 1) % 500 == 0:
            print(f"[score] {i+1}/{len(queries)} ({(i+1)/(time.time()-t0):.1f} q/s)")
json.dump(rows_out, open(f"/opt/reranker/reranked-{RUN_ID}.json", 'w'))
print(f"[score] wrote /opt/reranker/reranked-{RUN_ID}.json ({len(rows_out)} queries) — "
      f"metrics computed on the laptop from qrels.tsv, not here (no gold labels loaded on box)")
PY
fi

# 6. Upload weights FIRST (the run's only durable artifact), then results/logs.
#    2026-08-17 03:15: the results upload (denied prefix) ran before the weights
#    upload under set -e and the box self-terminated with the trained model on
#    a delete-on-termination volume — 43 GPU-minutes lost. Never again: weights
#    go up first, everything after is `|| true`.
aws s3 cp --only-show-errors --recursive "$DIR/model/final" "s3://$BUCKET/models/nsr-reranker-gte-modernbert/$RUN_ID/final/"
aws s3 cp --only-show-errors --recursive "$DIR/model" "s3://$BUCKET/models/nsr-reranker-gte-modernbert/$RUN_ID/" || true
[ -f "/opt/reranker/reranked-$RUN_ID.json" ] && aws s3 cp --only-show-errors "/opt/reranker/reranked-$RUN_ID.json" "s3://$BUCKET/models/nsr-reranker-gte-modernbert/$RUN_ID/reranked-$RUN_ID.json" || true
aws s3 cp --only-show-errors "$DIR/train.log" "s3://$BUCKET/logs/nsr-reranker-$RUN_ID-inner.log" || true
echo "[train.sh] done. weights: s3://$BUCKET/models/nsr-reranker-gte-modernbert/$RUN_ID/final/"
