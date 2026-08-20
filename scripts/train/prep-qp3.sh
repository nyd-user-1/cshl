#!/usr/bin/env bash
# prep-qp3.sh — runs ON a GPU box. LANE-QP3 phases 1-2: build the 140k slice,
# embed its queries with the cshl-QP2 checkpoint, ANCE-remine its negatives
# against preprint_embeddings_cshl_qp2, and leave the finished slice in S3.
#
# WHY THIS EXISTS AS A BOX SCRIPT. The converter was run on the laptop first and
# reached 7.85 GB RSS against 8 GB of RAM (red memory pressure, 4.9 GB swap)
# before the lead killed it: the text sidecar is 1.6 GB of strings and the
# emitted slice is ~2.2 GB, and both are resident at once. That is bulk data
# processing, which RIG-DOCTRINE puts on a self-terminating box, not here. The
# ANCE mine has the same shape (140k x 1024-d query vectors + the same sidecar)
# and needs Neon and a GPU besides, so all three steps run on one box and the
# laptop only ever holds the manifest.
#
# Contract: every stage verifies its own output by re-derivation and exits
# non-zero on failure, because the box terminates itself either way and a
# silent partial is indistinguishable from success once it is gone.
set -euo pipefail
export AWS_DEFAULT_REGION=${REGION:-us-east-1}
BUCKET=${BUCKET:-cshl-embed-rxiv}
PREFIX=${PREFIX:-prep/qp3}
RUN_ID=${RUN_ID:?set RUN_ID}
QP2_RUN=${QP2_RUN:-20260819-232838-train}
SLICE_NAME=${SLICE_NAME:-qpairs3}
export SLICE_NAME
FAMILY_TAKE=${FAMILY_TAKE:-MESH:45000,AUTHORKW:40000,OAKW:50000,EXTRACT:5000}
EXPECT_PAIRS=${EXPECT_PAIRS:-140000}
TOPK=${TOPK:-100}
SKIP_TOP=${SKIP_TOP:-5}
NEGS=${NEGS:-8}
CONC=${CONC:-16}
PY=/opt/pytorch/bin/python3
W=/opt/qp3
say() { echo "[prep-qp3 $(date -u +%H:%M:%SZ)] $*"; }

mkdir -p $W/data/mine $W/data/eval/cshl-eval-v1 $W/data/eval/cshl-eval-2k $W/scripts/train $W/scripts/eval
cd $W

# ── 0. node + deps ──────────────────────────────────────────────────────────
say "installing node"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y nodejs >/dev/null 2>&1
npm init -y >/dev/null 2>&1
npm i @neondatabase/serverless >/dev/null 2>&1
say "node $(node -v)"

# ── 1. inputs ───────────────────────────────────────────────────────────────
say "pulling inputs from s3://$BUCKET/$PREFIX/"
aws s3 cp s3://$BUCKET/$PREFIX/cshl-query-pairs.train.jsonl data/mine/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/cshl-oakw-pairs.train.jsonl  data/mine/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/corpus-text.jsonl            data/mine/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/eval-v1/qrels.tsv      data/eval/cshl-eval-v1/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/eval-v1/queries.jsonl  data/eval/cshl-eval-v1/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/eval-2k/qrels.tsv      data/eval/cshl-eval-2k/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/eval-2k/queries.jsonl  data/eval/cshl-eval-2k/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/scripts/from-mine.mjs  scripts/train/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/scripts/mine-ance.mjs  scripts/train/ --only-show-errors
aws s3 cp s3://$BUCKET/$PREFIX/scripts/score.mjs      scripts/eval/  --only-show-errors
printf 'DATABASE_URL_UNPOOLED=%s\n' "$DATABASE_URL" > .env.local
say "inputs: $(du -sh data/mine | cut -f1) mine, $(wc -l < data/mine/corpus-text.jsonl) corpus-text rows"

# ── 2. the 140k slice + slug sidecar ────────────────────────────────────────
say "STAGE 1 — building the slice (FAMILY_TAKE=$FAMILY_TAKE)"
IN=data/mine/cshl-query-pairs.train.jsonl,data/mine/cshl-oakw-pairs.train.jsonl \
TEXTS=data/mine/corpus-text.jsonl \
NAME=$SLICE_NAME-base OUT=data/train/$SLICE_NAME-base/train.jsonl \
FAMILY_TAKE="$FAMILY_TAKE" EVAL_DIR=data/eval/cshl-eval-v1 \
node --max-old-space-size=24000 scripts/train/from-mine.mjs

# verified by line count, not by exit code — the 4 GiB writev failure printed
# every gate as PASS on its way to a corrupt 270,192-line file.
BASE_N=$(wc -l < data/train/$SLICE_NAME-base/train.jsonl)
SIDE_N=$(wc -l < data/train/$SLICE_NAME-base/slice-slugs.jsonl)
say "slice: $BASE_N pairs, sidecar $SIDE_N rows (expect $EXPECT_PAIRS each)"
[ "$BASE_N" = "$EXPECT_PAIRS" ] || { say "ABORT: base slice is $BASE_N lines, expected $EXPECT_PAIRS"; exit 1; }
[ "$SIDE_N" = "$EXPECT_PAIRS" ] || { say "ABORT: sidecar is $SIDE_N lines, expected $EXPECT_PAIRS"; exit 1; }

# ── 3. embed the slice's queries with the cshl-QP2 checkpoint ───────────────
say "STAGE 2 — pulling cshl-QP2 weights ($QP2_RUN)"
aws s3 cp --recursive "s3://$BUCKET/models/cshl-encoder-bge-m3/$QP2_RUN/final/" /opt/qp2/ \
  --exclude "checkpoint-*/*" --only-show-errors
ls -la /opt/qp2/ | head
$PY -m pip install -q -U sentence-transformers 2>&1 | tail -3
say "STAGE 2 — embedding $EXPECT_PAIRS slice queries with cshl-QP2"
SP=/opt/pytorch/lib/python3.12/site-packages
export LD_LIBRARY_PATH="$(find "$SP/nvidia" -maxdepth 2 -type d -name lib 2>/dev/null | tr '\n' ':')"
$PY - <<'PYEOF'
import json, os, numpy as np, time
from sentence_transformers import SentenceTransformer
rows = [json.loads(l) for l in open('/opt/qp3/data/train/%s-base/slice-slugs.jsonl' % os.environ.get('SLICE_NAME','qpairs3')) if l.strip()]
print(f"[qemb] {len(rows)} queries", flush=True)
m = SentenceTransformer('/opt/qp2')
# Identical settings to train.sh section 5b, which produced qemb/cshl_qp2.jsonl:
# the ANCE retrieval must see the same query encoder the benchmark scored.
texts = [r['query'][:2000] for r in rows]
t0 = time.time()
E = m.encode(texts, normalize_embeddings=True, batch_size=256, show_progress_bar=False)
E = np.asarray(E)
dt = time.time() - t0
print(f"[qemb] dim={E.shape[1]} nan={bool(np.isnan(E).any())} norm_mean={np.linalg.norm(E,axis=1).mean():.4f} rows_per_s={len(texts)/dt:.0f}", flush=True)
assert E.shape[1] == 1024, E.shape
assert not np.isnan(E).any()
with open('/opt/qp3/qvec.jsonl','w') as f:
    for r, v in zip(rows, E):
        f.write(json.dumps({"qid": f"T-{r['i']}", "v": [round(float(x),6) for x in v]}) + "\n")
print("[qemb] wrote /opt/qp3/qvec.jsonl", flush=True)
PYEOF
QV_N=$(wc -l < qvec.jsonl)
[ "$QV_N" = "$EXPECT_PAIRS" ] || { say "ABORT: qvec.jsonl is $QV_N lines, expected $EXPECT_PAIRS"; exit 1; }
say "qvec: $QV_N vectors"

# ── 4. ANCE mine ────────────────────────────────────────────────────────────
say "STAGE 3 — ANCE mine against preprint_embeddings_cshl_qp2 (top-$TOPK, skip_top=$SKIP_TOP, conc=$CONC)"
ARM=cshl_qp2 \
QVEC=qvec.jsonl \
QMETA=data/train/$SLICE_NAME-base/slice-slugs.jsonl \
OUT=data/train/$SLICE_NAME/train.jsonl \
TEXTS=data/mine/corpus-text.jsonl \
EVAL_DIR=data/eval/cshl-eval-v1 \
TOPK=$TOPK SKIP_TOP=$SKIP_TOP NEGS=$NEGS CONC=$CONC \
ALLOW_TRAIN_WRITE=1 \
node --max-old-space-size=24000 scripts/train/mine-ance.mjs

FINAL_N=$(wc -l < data/train/$SLICE_NAME/train.jsonl)
say "final slice: $FINAL_N pairs"
[ "$FINAL_N" = "$EXPECT_PAIRS" ] || { say "ABORT: final slice is $FINAL_N lines, expected $EXPECT_PAIRS"; exit 1; }

# ── 5. independent verification of the emitted slice ────────────────────────
say "STAGE 4 — verifying the emitted slice from source, not from the miner's word"
$PY - <<'PYEOF'
import json, os, sys, hashlib
name = os.environ.get('SLICE_NAME','qpairs3')
base = f'/opt/qp3/data/train/{name}-base'
out  = f'/opt/qp3/data/train/{name}'
gold = set()
for l in open('/opt/qp3/data/eval/cshl-eval-v1/qrels.tsv'):
    a = l.rstrip('\n').split('\t')
    if len(a) > 1 and a[0] != 'qid': gold.add(a[1])
gold2k = set()
for l in open('/opt/qp3/data/eval/cshl-eval-2k/qrels.tsv'):
    a = l.rstrip('\n').split('\t')
    if len(a) > 1 and a[0] != 'qid': gold2k.add(a[1])
# text -> slug, so the emitted TEXT slice can be checked against the paper-level
# holdout even though it carries no ids. This is the check the manifest cannot
# make for itself.
t2s = {}
for l in open('/opt/qp3/data/mine/corpus-text.jsonl'):
    o = json.loads(l)
    if o.get('embed_text'): t2s.setdefault(o['embed_text'], o['key'])
side = [json.loads(l) for l in open(f'{base}/slice-slugs.jsonl')]
fam_side = {}
for r in side: fam_side[r['family']] = fam_side.get(r['family'],0)+1
n=0; leaks=0; leaks2k=0; posneg=0; unresolved=0; shortneg=0; negn={}
for l in open(f'{out}/train.jsonl'):
    o = json.loads(l); n += 1
    ps = t2s.get(o['pos'][0])
    if ps is None: unresolved += 1
    elif ps in gold: leaks += 1
    elif ps in gold2k: leaks2k += 1
    negs = o['neg']; negn[len(negs)] = negn.get(len(negs),0)+1
    if len(negs) < 4: shortneg += 1
    for t in negs:
        if t == o['pos'][0]: posneg += 1
        ns = t2s.get(t)
        if ns is not None and ns in gold: leaks += 1
        if ns is not None and ns in gold2k: leaks2k += 1
print(f"[verify] emitted rows        : {n}")
print(f"[verify] sidecar families    : {fam_side}")
print(f"[verify] negatives/row       : {negn}")
print(f"[verify] rows with <4 negs   : {shortneg}                 (must be 0)")
print(f"[verify] positive == its own negative : {posneg}          (must be 0)")
print(f"[verify] slugs in cshl-eval-v1 gold   : {leaks}           (must be 0)")
print(f"[verify] slugs in cshl-eval-2k gold   : {leaks2k}         (must be 0)")
print(f"[verify] positives whose text did not resolve to a slug: {unresolved}")
bad = (shortneg or posneg or leaks or leaks2k)
sys.exit(1 if bad else 0)
PYEOF
say "verification passed"

# ── 6. upload ───────────────────────────────────────────────────────────────
say "uploading slice -> s3://$BUCKET/train/$SLICE_NAME/"
aws s3 cp data/train/$SLICE_NAME/train.jsonl    s3://$BUCKET/train/$SLICE_NAME/train.jsonl    --only-show-errors
aws s3 cp data/train/$SLICE_NAME/manifest.json  s3://$BUCKET/train/$SLICE_NAME/manifest.json  --only-show-errors
aws s3 cp data/train/$SLICE_NAME-base/manifest.json    s3://$BUCKET/train/$SLICE_NAME/base-manifest.json --only-show-errors
aws s3 cp data/train/$SLICE_NAME-base/slice-slugs.jsonl s3://$BUCKET/train/$SLICE_NAME/slice-slugs.jsonl --only-show-errors
say "DONE. pairs=$FINAL_N"
