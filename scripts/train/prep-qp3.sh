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

# ── 4b. STAGE THE ARTIFACT BEFORE VERIFYING IT ──────────────────────────────
# The first full run mined all 140,000 rows correctly in 21 minutes and then
# ABORTED at an exact-equality line-count gate that was off by one — for a
# legitimate reason — and the box terminated with its EBS volume, taking the
# whole mine with it. Verification must never be the thing that destroys the
# work it is verifying. The slice goes to a STAGING prefix first; it is promoted
# to train/ only after the gates pass, and a failed run leaves its artifact
# behind for inspection instead of a log describing something that no longer
# exists. The promote is a server-side S3 copy: instant, no re-upload.
say "staging slice -> s3://$BUCKET/$PREFIX/staging/ (before verification, so a failed gate cannot destroy it)"
aws s3 cp data/train/$SLICE_NAME/train.jsonl   s3://$BUCKET/$PREFIX/staging/train.jsonl   --only-show-errors
aws s3 cp data/train/$SLICE_NAME/manifest.json s3://$BUCKET/$PREFIX/staging/manifest.json --only-show-errors
aws s3 cp data/train/$SLICE_NAME-base/slice-slugs.jsonl s3://$BUCKET/$PREFIX/staging/slice-slugs.jsonl --only-show-errors
aws s3 cp data/train/$SLICE_NAME-base/manifest.json     s3://$BUCKET/$PREFIX/staging/base-manifest.json --only-show-errors
say "staged."

# The gate is an ACCOUNTING IDENTITY, not a bare equality: every mined row must
# be accounted for as either written or explicitly unwritable, and unwritable
# must be zero. That rejects real loss while tolerating a legitimate repair.
$PY - <<PYEOF
import json, sys
m = json.load(open('/opt/qp3/data/train/$SLICE_NAME/manifest.json'))
written    = m['pairs']
unwritable = m.get('rows_unwritable_for_missing_text', 0)
repaired   = m.get('rows_repaired_positive_appeared_as_negative', 0)
expect     = $EXPECT_PAIRS
print(f"[gate] written {written} + unwritable {unwritable} = {written+unwritable} (expect {expect})")
print(f"[gate] rows repaired (negative text == positive text): {repaired}")
ok = (written + unwritable == expect) and unwritable == 0 and written == expect
print("[gate] PASS" if ok else "[gate] FAIL")
sys.exit(0 if ok else 1)
PYEOF

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
# The emitted slice is TEXT ONLY, so checking it against a paper-level holdout
# means mapping text back to identity. The obvious way — a text->slug dict — is
# WRONG, and run 2 proved it: 31 groups of papers in this corpus share a
# byte-identical embed_text, so `setdefault` keeps whichever slug appears first
# and a non-gold paper's text can resolve to a gold twin's slug. That reported 9
# "leaks" that were not leaks, and it can silently miss real ones in the other
# direction.
#
# The right question is not "which slug is this text?" but "is this text the
# text of ANY held-out paper?" — a set of gold TEXTS, which is exact and has no
# first-wins ambiguity. Kept separate from the slug gates in from-mine.mjs and
# mine-ance.mjs, which remain authoritative for the paper-level holdout; this is
# the text-level question those cannot answer.
gold_text_v1, gold_text_2k, t2s = set(), set(), {}
for l in open('/opt/qp3/data/mine/corpus-text.jsonl'):
    o = json.loads(l)
    t = o.get('embed_text')
    if not t: continue
    t2s.setdefault(t, o['key'])
    if o['key'] in gold:   gold_text_v1.add(t)
    if o['key'] in gold2k: gold_text_2k.add(t)
side = [json.loads(l) for l in open(f'{base}/slice-slugs.jsonl')]
fam_side = {}
for r in side: fam_side[r['family']] = fam_side.get(r['family'],0)+1
n=0; leaks=0; leaks2k=0; posneg=0; unresolved=0; shortneg=0; negn={}
negtext_v1=0; negtext_2k=0
for l in open(f'{out}/train.jsonl'):
    o = json.loads(l); n += 1
    if t2s.get(o['pos'][0]) is None: unresolved += 1
    if o['pos'][0] in gold_text_v1: leaks += 1
    if o['pos'][0] in gold_text_2k: leaks2k += 1
    negs = o['neg']; negn[len(negs)] = negn.get(len(negs),0)+1
    if len(negs) < 4: shortneg += 1
    for t in negs:
        if t == o['pos'][0]: posneg += 1
        if t in gold_text_v1: negtext_v1 += 1
        if t in gold_text_2k: negtext_2k += 1
print(f"[verify] emitted rows        : {n}")
print(f"[verify] sidecar families    : {fam_side}")
print(f"[verify] negatives/row       : {negn}")
print(f"[verify] rows with <4 negs   : {shortneg}                 (must be 0)")
print(f"[verify] positive == its own negative : {posneg}          (must be 0)")
print(f"[verify] POSITIVE text == a held-out paper's text (v1/2k) : {leaks} / {leaks2k}   (must be 0 — a real leak)")
print(f"[verify] NEGATIVE text == a held-out paper's text (v1/2k) : {negtext_v1} / {negtext_2k}   (disclosed, not fatal)")
print(f"[verify] positives whose text did not resolve to a slug   : {unresolved}")
# A held-out paper's text appearing as a NEGATIVE is disclosed, not fatal, and
# the direction is why: training a gold paper's text as a negative can only make
# it HARDER to retrieve at eval. It cannot inflate the result — it can only cost
# us. A positive matching held-out text WOULD be a real leak and is fatal.
bad = (shortneg or posneg or leaks or leaks2k)
sys.exit(1 if bad else 0)
PYEOF
say "verification passed"

# ── 6. upload ───────────────────────────────────────────────────────────────
# PROMOTE from staging — server-side copies, nothing re-uploaded.
say "promoting staging -> s3://$BUCKET/train/$SLICE_NAME/"
for f in train.jsonl manifest.json slice-slugs.jsonl base-manifest.json; do
  aws s3 cp "s3://$BUCKET/$PREFIX/staging/$f" "s3://$BUCKET/train/$SLICE_NAME/$f" --only-show-errors
done
say "DONE. pairs=$FINAL_N"
