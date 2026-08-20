# LANE-QP3 — the keyword offensive (D8)

Append-only, timestamped. Branch `lane/rxiv-load`. Cap **$12**.

Targets: encoder AUTHORKW > 0.8076 (MedCPT); system (QP3 + cshl-RR) AUTHORKW
> 0.8577 and blended > 0.6510 (medcpt + MedCPT-CE).

---

## 2026-08-20T??:??Z — branch

D8 names `lane/rxiv-load`. Local `lane/rxiv-load` was a strict ancestor of
`lane/proof-page` (31 commits behind `origin/lane/rxiv-load`'s tip counted
against proof-page), and the two documents D8 orders me to read first —
`LANE-WIN.md` and `LANE-KEYWORDS.md` — live only on `lane/proof-page`.
Checked out `lane/rxiv-load` and **fast-forwarded** it to `59f94ae` (no merge
commit, no content decision made). Working on `lane/rxiv-load` as instructed,
with every document D8 depends on present.

---

## 2026-08-20T??:??Z — FIX FIRST (lead's addition (a))

### The report, and what was actually there

> `cshl_qp2+cshl_rr.json` has a wrong aggregate metrics block (it duplicates
> the base encoder's numbers).

**The numbers in that file were never wrong.** I re-derived all four system
arms from their source `reranked-*.json` + the frozen `qrels.tsv`/`queries.jsonl`
with an independent scorer (`scratchpad/verify.mjs`, no import from the repo's
scorers) and every one of the 4 arms x 2 families x 6 metrics reproduced the
stored digits exactly. `cshl-QP2+cshl-RR` blended:

```
AUTHORKW  n=759   r1 0.5955  r5 0.7589  r10 0.8024  r50 0.8669  mrr 0.6706  ndcg 0.7002
MESH      n=1241  r1 0.3062  r5 0.4811  r10 0.5488  r50 0.6728  mrr 0.3855  ndcg 0.4193
```

MESH 0.5488 / AUTHORKW 0.8024 — matching the lead's independent verification.
Guards re-run at assertion time: 2000/2000 rows scored, 0 missing, 0 rows where
the reranked list was not a permutation of the raw list. Source digests differ
between arms that must differ (`reranked-medcpt_cshlrr` a8f… vs
`reranked-medcpt_medcptce` 7f1…; identical file *sizes* are expected — same
qids, same doc ids, permuted).

### So what was the defect? A shape defect, and it is a real one

`score-rerank-cshl.mjs` wrote

```
metrics: { raw: {FAM:{seg}}, reranked: {FAM:{seg}} }
```

while **every** encoder arm written by `score.mjs` writes `metrics: {FAM:{seg}}`.
Two live costs:

1. **A silent-null for any generic reader.** `scripts/publish-nsr/fill-card.mjs`
   ingests every `results/*.json` and does `m[family] ?? Object.keys(m).find(k => k !== 'TITLE')`.
   For a system arm that resolves to the literal key `'raw'`, then reads
   `m['raw'].blended` — undefined — and emits **null** into a model card. No error.
2. **A guaranteed human misread.** `metrics.raw` is the first block in the file
   and is byte-identical to the base encoder's own `results/cshl_qp2.json`. Anyone
   opening the file sees the base encoder's digits where they expect the arm's,
   and concludes the rerank did nothing. That is exactly the report I was handed.

Both are the dominant failure mode the house rules name: an operation that
reports success while conveying nothing.

### Fix

`metrics` now means the same thing for every file in `results/` — **this arm's
numbers** — and the raw base-encoder top-50 baseline moves to `base_metrics`,
named for what it is, with a `metrics_note` stating the contract inline.

Regenerated all four system arms (the earlier `cshl_qp+cshl_rr` row carried the
identical defect, as did both MedCPT system rows). Verified against pre-fix
copies: `new.metrics == old.metrics.reranked` and `new.base_metrics == old.metrics.raw`
for **4/4** files — the shape changed, not one digit.

| arm | AUTHORKW R@10 | MESH R@10 |
|---|---|---|
| `cshl_qp+cshl_rr` | 0.7668 | 0.5238 |
| `cshl_qp2+cshl_rr` | **0.8024** | **0.5488** |
| `medcpt+cshl_rr` | 0.8235 | 0.5439 |
| `medcpt+medcpt_ce` | 0.8577 | 0.5246 |

### HERO-STAT check — **does not verify at +186%**

Asked: cshl-QP2+cshl-RR MESH R@1 vs stock bge-m3's 0.1176, flag if near/past +186%.

```
0.3062 / 0.1176 = 2.604x  ->  +160.4%
```

**+160.4%, not +186%** — 26 points short, so I am not flagging it as HERO-STAT
on the stated threshold. Nothing in the grid lands near +186%: the largest
relative jump anywhere is this one. For the record, the full vs-stock grid:

| metric | MESH QP2 | MESH QP2+RR | AUTHORKW QP2 | AUTHORKW QP2+RR |
|---|---:|---:|---:|---:|
| R@1 | +128.8% | **+160.4%** | +17.0% | +30.2% |
| R@5 | +101.8% | +117.1% | +18.7% | +24.9% |
| R@10 | +83.1% | +91.8% | +17.2% | +23.0% |
| MRR | +105.2% | +124.3% | +17.8% | +27.8% |
| nDCG@10 | +99.8% | +115.9% | +17.7% | +26.8% |

The honest headline is still large and clean: **MeSH R@1 more than 2.6x over
stock bge-m3, 0.1176 -> 0.3062.** I am reporting 2.6x rather than the 2.86x the
threshold implies.

---

## 2026-08-20T07:30–07:53Z — D8 step 2 preflight: OAKW verified, slice spec fixed

D8 makes OAKW conditional: *"verify its manifest + benchmark disjointness before
use; if the file is missing or fails its gates, proceed at 90k without OAKW and
say so loudly."* **It passes, so the slice is the full 140k.** Verified from the
files, not from the manifest's own counters:

```
rows                                 479,969   == manifest.files.rows          ✓
sha256  7956fddf3f8115041fad08712c2cd61b16cb50b70c448ad1fbc87497b34811ea        ✓ (matches manifest)
families                             OAKW 235,482 · OATOPIC 244,487
negatives/row                        {8: 479,969}   — none thin
POSITIVES that are cshl-eval-2k gold        0   (must be 0)
NEGATIVES that are cshl-eval-2k gold        0   (must be 0)
POSITIVES that are cshl-eval-v1 gold        0   (must be 0)
NEGATIVES that are cshl-eval-v1 gold        0   (must be 0)
train query strings == a benchmark query    0
```

OAKW supplies 235,482 usable rows against the 50,000 the slice asks for. Only
the OAKW family is taken; **OATOPIC is not used**, per its own manifest's caveat
that it is a classification target rather than a query.

**A gate-coverage trap, checked rather than assumed.** Every training slice in
this program gates against `cshl-eval-v1/qrels.tsv`, but the arm is scored on
`cshl-eval-2k`. If 2k's gold papers were not covered by v1's gate, training
would leak into the benchmark and every number would be worthless. Measured:

```
cshl-eval-2k unique gold papers   1,839
cshl-eval-v1 unique gold papers   6,203
in 2k but NOT in v1                   0      <- the v1 gate strictly covers 2k
```

(943 of 2k's *qids* are absent from v1, so the qid sets differ — but the holdout
is defined over PAPERS, and at paper level 2k ⊂ v1. The gate holds.)

### The slice spec, built and verified

```
FAMILY_TAKE  MESH:45,000  AUTHORKW:40,000  OAKW:50,000  EXTRACT:5,000
  MESH:     102,667 convertible -> 45,000
  AUTHORKW:  62,166 convertible -> 40,000   (all of the family is 62,166; 40,000 as specified)
  OAKW:     235,482 convertible -> 50,000
  EXTRACT:  259,920 convertible ->  5,000
  OATOPIC:  244,487 convertible ->      0   (not named)
EMITTED families      {"MESH":45000,"AUTHORKW":40000,"OAKW":50000,"EXTRACT":5000}
FAMILY_TAKE VERIFIED  families_emitted matches the spec exactly (140,000 pairs)
EMITTED disjointness  0 references to frozen-benchmark gold papers
query-string overlap  695 / 140,000 (disclosed; the benchmark splits by paper)
```

---

## 2026-08-20T07:45Z — lead intervention: the converter is bulk processing, and it broke

The lead killed the local converter at **7.85 GB RSS on an 8 GB laptop** (red
memory pressure, 4.9 GB swap). Correct call and my error: the text sidecar is
1.6 GB of strings and the emitted slice ~2.2 GB, both resident, which is exactly
the bulk data processing RIG-DOCTRINE puts on a box.

It had also already produced a **corrupt artifact**, which is the more
interesting half:

```
data/train/qpairs3/train.jsonl   4,294,967,296 bytes  (exactly 2^32)
                                       270,192 lines  (for 140,000 rows)
ERR_SYSTEM_ERROR: writev failed
```

Every gate printed PASS — `FAMILY_TAKE VERIFIED`, `0 references to
frozen-benchmark gold papers`, `140,000 pairs` — and *then* the write produced
1.9x the rows it had verified and died. Piped through `tail`, the shell reported
**exit 0**. Three of this program's named failure modes in one line: an
operation that reports success while doing nothing useful, a verification that
ran before the thing it verified existed, and an exit code that lied.

**Root cause, and it is a real bug, not a laptop symptom.** The writer read:

```js
for (const x of out) if (!ws.write(...)) { /* backpressure ok at this size */ }
```

`ws.write()` returning `false` means *stop*. Ignoring it queues every unflushed
chunk in memory and hands the backlog to one `writev()`, which fails at 2^32
bytes. The comment was true when the slice was 40k pairs. At 140k it is false,
and nothing re-checked it. Fixed in both `from-mine.mjs` and `mine-ance.mjs` by
awaiting `'drain'`; both now also stream their output from a generator rather
than materialising it.

### Structural response: the whole pre-train pipeline moves to one box

Not just the converter — the ANCE mine has the same shape (the same 1.6 GB
sidecar plus 140k x 1024-d query vectors) and needs a GPU and Neon besides. So
`scripts/train/prep-qp3.sh` + `scripts/train/launch-prep.sh` (new) do all of
stage 1-3 on one self-terminating box: build the slice, embed its 140k queries
with the cshl-QP2 checkpoint, ANCE-remine against
`preprint_embeddings_cshl_qp2`, verify, upload to S3. The laptop holds only
manifests. `launch-prep.sh` is a port of the proven `launch.sh` — SSM
SecureString + endpoint fence, the `set +x` window around the credential, reused
embed role/SG, TYPE_MENU walked type-by-type across every offered AZ with the
load-bearing `|| true`, watchdog, terminate-on-shutdown, DRYRUN. Its one policy
change is `s3:PutObject` on `train/*` and `prep/*`, which `launch.sh`'s policy
(logs + models only) does not grant — the box would otherwise have run the
entire pipeline and died on AccessDenied at the upload.

---

## 2026-08-20T07:53–08:15Z — the ANCE miner had a dead gate. Proven, then fixed.

`mine-ance.mjs` was pre-staged and smoke-tested under LANE-WIN, and its header
names false negatives as the failure that makes ANCE rounds silently worse. It
lists among its gates: *"the positive itself can never be a negative."*

**On the path the real mine would have used, that gate was dead.** The script
recognised two QMETA shapes. The smoke test ran the `benchmark-dir` shape, where
gold comes from `qrels.tsv` and the gate is real. The full mine was documented to
run the `train-jsonl` shape — a FlagEmbedding `train.jsonl`, which is text-only
and carries no paper identity — and that branch builds:

```js
meta.set(`T-${i++}`, { text: o.query, gold: new Set(), posText: o.pos?.[0] })
                                      ^^^^^^^^^^^^^^ empty, always
```

Every `m.gold.has(...)` check downstream therefore rejects nothing. The gate the
smoke test demonstrated is **not the gate the real mine would have used**.

### Proven on real data rather than argued

`from-mine.mjs` now emits `slice-slugs.jsonl` beside every `train.jsonl` — row
for row, carrying the positive's slug and the original negatives — and
`mine-ance.mjs` gained a third named shape that reads it. Test: take 40 rows,
and use as each query's vector **the positive document's own embedding, pulled
from the very table the miner searches**, so the positive is rank 1 by
construction and a working gate must strike it.

| run | shape | `gold landed` | own-gold struck | positive emitted as its own negative |
|---|---|---|---:|---:|
| A | `slice-slugs` (fixed) | `{"top1":40}` | **40** | 0 |
| B | `train-jsonl` (old) | `{}` | **0** | 0 (masked — see below) |
| C | `train-jsonl` (old), `SKIP_TOP=0` | — | **0** | **5 of 5** |

Run C is the proof. With `SKIP_TOP=0` the old path emitted the query's own
correct answer as its own hard negative on **every** writable row, and the only
thing that caught it was a belt-and-braces text comparison I added at the write
step. Run B shows why it was invisible: at `SKIP_TOP=5` a positive ranked 1-5 is
discarded as a likely-unlabelled positive anyway, so the dead gate is masked
*for exactly the queries the model already gets right*. It bites on the rest —
and LANE-WIN's own gold-rank histogram measured **~42% of queries with the gold
below rank 1 and ~10% below rank 10**, which is the population it would have hit.

### Two more defects the fixture found before the box did

1. **Rows dropped silently when ANCE negatives had no text.** A row whose mined
   negatives failed text resolution was skipped, so the slice would come out
   under 140,000 and the FAMILY_TAKE mix that was verified at build time would
   quietly not be the mix trained on. Now falls back to the inherited negatives.
   In the fixture this turned **1 written row into 36**, still exit 0 either way.
2. **The fallback could never resolve.** `need` — the slug set whose text gets
   loaded — included inherited negatives only for rows that had *already* failed
   to mine, so a successfully-mined row's fallback had no text behind it. Fixed;
   the fixture then rescued **31 of 35** rows instead of 0.

D8's rule "ANCE negatives wherever mined; existing negatives elsewhere" is now
what the code does, counted per family in the manifest as `negatives_source`.

---

## 2026-08-20T08:05Z — pre-staged command lines for every phase

Written out now, against `preprint_embeddings_cshl_qp3` (the **fifth** table;
`qp` and `qp2` untouched, asserted at close), so no phase waits on composing a
command. Registry entry `cshl_qp3` added to `scripts/eval/score.mjs`; table
created empty and verified alongside the other seven.

**Q1 — prep box (slice + query embed + ANCE mine + verify + upload):**
```sh
DRYRUN=1 ./scripts/train/launch-prep.sh     # verified clean
./scripts/train/launch-prep.sh
# completion signal — poll the artifact, not the instance:
aws s3 ls s3://cshl-embed-rxiv/train/qpairs3/
aws s3 cp s3://cshl-embed-rxiv/logs/cshl-prep-<run>.rc -   # "0" == every stage gate passed
```

**Q2 — train, QP2's exact config, only the data changed:**
```sh
MODE=train TRAIN_NAME=qpairs3 EVAL_VERSION=cshl-eval-2k \
TYPE_MENU="g6e.2xlarge" NPROC=1 BATCH=8 GROUP_SIZE=8 \
QUERY_MAX_LEN=128 PASSAGE_MAX_LEN=384 EPOCHS=1 SAVE_STEPS=400 \
WATCHDOG_MIN=280 ./scripts/train/launch.sh
```
Confirmed against LANE-WIN 03:28Z: `NPROC=1 BATCH=8 GROUP_SIZE=8
QUERY_MAX_LEN=128 PASSAGE_MAX_LEN=384 EPOCHS=1 SAVE_STEPS=400` is character-for-
character the config that produced cshl-QP2. 140,000 pairs / batch 8 =
**17,500 steps**; at LANE-WIN's measured 0.658 s/step that is **192 min** of
training plus ~7 min setup and ~6 min upload/query-embed = ~205 min, inside the
280-min watchdog with 75 min of headroom.

**Q3 — slim the weights before four boxes download them:**
```sh
aws s3 cp --recursive --exclude 'checkpoint-*' \
  s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/<run>/final/ \
  s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/<run>/serve/
```

**Q4 — re-embed into the FIFTH table, N=4:**
```sh
MODEL_S3=s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/<run>/serve \
EMB_TABLE=preprint_embeddings_cshl_qp3 EMB_MODEL=cshl-encoder-bge-m3-qpairs3 \
DIM=1024 NORMALIZE=1 CAP=4000 N=4 TYPE=g6e.xlarge ./scripts/embed-nsr/launch.sh
# g6e unavailable -> TYPE=g5.xlarge AND TEI_IMAGE=...:86-1.8 (the 89 image is
#   Ada-only and on Ampere starts a container that never loads a model and never
#   complains — LANE-WIN's trap, inherited not re-derived)
```

**Q5 — query vectors (the cross-arm digest guard is the point), then index, then gate:**
```sh
aws s3 cp s3://cshl-embed-rxiv/eval/cshl-eval-2k/qemb-<run>.jsonl /tmp/qp3.jsonl
SRC=/tmp/qp3.jsonl ARM=cshl_qp3 VERSION=cshl-eval-2k EXPECT_DIM=1024 \
  node scripts/eval/qemb-from-run.mjs
```
```sql
CREATE INDEX IF NOT EXISTS idx_pp_emb_cshl_qp3_hnsw
  ON preprint_embeddings_cshl_qp3 USING hnsw (embedding vector_cosine_ops);
```
```sh
ARMS=cshl_qp3 EXPECT_CORPUS=433449 node scripts/eval/coverage-gate.mjs
```

**Q6 — score: controls first (published digits must reproduce), then QP3:**
```sh
ARMS=bge-m3,medcpt,cshl_qp,cshl_qp2 EVAL_VERSION=cshl-eval-2k node scripts/eval/score.mjs
ARMS=cshl_qp3 EVAL_VERSION=cshl-eval-2k node scripts/eval/score.mjs
A=cshl_qp3 B=medcpt   EVAL_VERSION=cshl-eval-2k node scripts/eval/paired-test.mjs
A=cshl_qp3 B=cshl_qp2 EVAL_VERSION=cshl-eval-2k node scripts/eval/paired-test.mjs
# and per family, which is where the verdict lives:
A=cshl_qp3 B=medcpt EVAL_VERSION=cshl-eval-2k FAMILY=MESH     node scripts/eval/paired-test.mjs
A=cshl_qp3 B=medcpt EVAL_VERSION=cshl-eval-2k FAMILY=AUTHORKW node scripts/eval/paired-test.mjs
```

**Q7 — rerank QP3's top-50 with cshl-RR (the three proven commands):**
```sh
ARM=cshl_qp3 EVAL_VERSION=cshl-eval-2k node scripts/rerank-nsr/dump-candidates.mjs
MODEL_RUN=20260819-223601-train ARM=cshl_qp3 ./scripts/rerank-nsr/score-launch.sh
IN=<pulled reranked.json> BASE=cshl_qp3 ARM=cshl_qp3+cshl_rr \
  node scripts/rerank-nsr/score-rerank-cshl.mjs
A=cshl_qp3+cshl_rr B=medcpt+medcpt_ce EVAL_VERSION=cshl-eval-2k node scripts/eval/paired-test.mjs
```

### Budget, priced before firing (cap $12)

| phase | box | rate | est. min | $ |
|---|---|---|---:|---:|
| Q1 prep | 1x g6e.xlarge | 1.861/h | ~45 | 1.40 |
| Q2 train | 1x g6e.2xlarge | 2.24208/h | ~205 | 7.66 |
| Q4 re-embed | 4x g6e.xlarge | 1.861/h | ~7 each | 0.90 |
| Q7 rerank | 1x g6e.2xlarge | 2.24208/h | ~10 | 0.15 |
| S3 + Neon | — | — | — | ~0.15 |
| | | | **est. total** | **≈10.26** |

That leaves **≈$1.74** against the $1.70 the conditional cshl-RR retrain (step 6)
is priced at. **Stated up front: the conditional almost certainly does not fit
under the cap.** If step 6 is triggered I will price the *actual* spend to that
point first and write BLOCKED rather than exceed $12.

---

## 2026-08-20T08:12Z — budget challenged by the lead ("why so high?"). Re-derived.

The gap between my $10.26 and D8's implied budget is three separate things, and
**one of them was my error.** Prices below are from the AWS pricing API, read
now, not remembered.

```
g6e.xlarge   $1.86100/h   4 vCPU   32 GiB   L40S 48 GB
g6e.2xlarge  $2.24208/h   8 vCPU   64 GiB   L40S 48 GB
g6.2xlarge   $0.97760/h   8 vCPU   32 GiB   L4   24 GB
g5.2xlarge   $1.21200/h   8 vCPU   32 GiB   A10G 24 GB
```

**1. D8 does not budget the prep box at all — and one is unavoidable. (~$0.80)**
Step 1 says "run the pre-staged miner at full scale ... for the training
queries." The miner takes a query VECTOR per training query, encoded by
cshl-QP2. There are 140,000 of them, and `mine-ance.mjs`'s own header says so:
*"needs 100k training-query vectors from a TEI box serving the current
checkpoint, which is a GPU box and therefore spend."* The requirement is
documented in the script and absent from the plan's arithmetic. Not a
disagreement — a cost that fell between the two.

**2. MY ERROR: I put that box on the wrong instance. (−$0.62)**
I defaulted to `g6e.xlarge` — the type LANE-WIN used for embedding the 433k-row
corpus, where L40S throughput is the whole job. This box's work is a slice build
(CPU), a Neon kNN sweep (network), and ~5 min of encoding short keyword strings.
`g6.2xlarge` has **identical 32 GiB RAM at 52% of the rate** and an L4 that is
far more than adequate for bge-m3 on ~30-token queries. TYPE_MENU is now
`g6.2xlarge,g5.2xlarge,g6e.xlarge` — cheapest adequate first, the L40S kept only
as a capacity fallback. **$1.40 -> $0.80.**

**3. Train: $7.72 vs D8's $7.30, and I'll stand on mine. (+$0.42)**
D8's figure prices training time only. LANE-WIN's measured QP2 run is the
control: a 137-min training job against a **151.8-min billed instance lifetime**
— 14.8 min of boot, install, weight upload and query embed that are billed and
real. 17,500 steps x 0.658 s/step = 191.9 min + that same measured 14.8 =
206.7 min = **$7.72**. I would rather carry the overhead than discover it.

Re-embed ($0.90) and rerank ($0.15) are LANE-WIN's and LANE-RERANK's **measured
actuals**, not estimates.

### Revised budget

| phase | box | rate | est. min | $ |
|---|---|---|---:|---:|
| Q1 prep | 1x g6.2xlarge | 0.97760/h | ~48 | 0.78 |
| Q2 train | 1x g6e.2xlarge | 2.24208/h | ~207 | 7.72 |
| Q4 re-embed | 4x g6e.xlarge | 1.86100/h | ~7 each | 0.90 |
| Q7 rerank | 1x g6e.2xlarge | 2.24208/h | ~10 | 0.15 |
| S3 + Neon | — | — | — | ~0.15 |
| | | | **total** | **≈ 9.70** |

**≈$2.30 left against the $1.70 conditional — it fits**, with ~$0.60 of margin.
I withdraw the earlier flag. The margin is thin enough that I will re-price
actual spend from measured instance lifetimes before firing step 6, rather than
assume the estimate held.

---

## 2026-08-20T08:12:02Z — Q1 FIRED: prep box `i-04addd198e067c44f`

Cap raised to **$15** by the lead at 08:11Z, which settles the conditional: step
6 now has room. The revised plan stands regardless.

```
run_id     20260820-041120-prep
instance   i-04addd198e067c44f   g5.2xlarge   subnet-0aeeab33ec7ee352e   08:12:02Z
watchdog   90 min  (fires 09:42Z)
```

**The TYPE_MENU walk earned its keep on the first launch of the night.**
`g6.2xlarge` was capacity-refused in **all five** AZs, and the walk fell through
to `g5.2xlarge` — same 8 vCPU / 32 GiB, A10G instead of L4, $1.21200/h instead
of $0.97760/h. Cost of the fallback: **+$0.19** on a ~48-min box. Cost of not
having the walk: the run stops here. (The `|| true` on the `launch_in`
assignment is what makes those five refusals survivable under `set -e`; without
it the first one exits the whole script.)

Revised prep line: ~48 min x $1.21200/h = **$0.97** (planned $0.78).
Running total estimate **≈$9.89** against the $15 cap.

Two watches armed, because a log that stops printing and a job that stopped
working look identical from one of them: an SSM poll of the box's own progress
line **filtered on failure signatures as well as stage markers**
(`ABORT|Traceback|Error|FATAL|Killed|OOM|exited`, so silence cannot be read as
health), plus the instance state itself, which reports the box being gone.

Completion signal is the artifact, not the instance:
`s3://cshl-embed-rxiv/train/qpairs3/train.jsonl` plus a `.rc` of `0`.

---

## 2026-08-20T08:18Z — Q2's capacity fallback decided BEFORE the moment, not during it

`g6.2xlarge` was refused in all five AZs at 08:12Z. Capacity is tight tonight, so
the training launch needs a fallback ladder decided now — D8 names a single type
(`TYPE_MENU="g6e.2xlarge"`), and a single-type menu is a run that stops.

The constraint is memory, and it is measured, not guessed: LANE-WIN recorded
`BATCH=8 PASSAGE_MAX_LEN=384` using **33,899 MiB**. That rules out every 24 GB
card — A10G and L4 both — which is also why LANE-WIN's 4x A10G attempt OOMed,
halved the batch, and was killed for $0.90. So the ladder cannot trade down to a
smaller GPU; it can only trade *up* to another host carrying the same L40S:

```
g6e.2xlarge  $2.24208/h   8 vCPU   64 GiB   1x L40S 48 GB   <- D8's type
g6e.4xlarge  $3.00424/h  16 vCPU  128 GiB   1x L40S 48 GB   <- same GPU, +34%
```

**`TYPE_MENU="g6e.2xlarge,g6e.4xlarge"`.** The fallback changes the host and
nothing else — same single L40S, same batch 8, same 0.658 s/step — so the
experiment's config is untouched by which one wins. If the fallback fires,
training costs $10.35 instead of $7.72 and the run total lands ≈$12.5, inside
the $15 cap. That is a better outcome than a clean stop.

`g6e.2xlarge` is currently offered in us-east-1a/b/c/d (offering != capacity;
this only proves the AZ walk has four subnets to try).

---

## 2026-08-20T08:14–08:17Z — prep box stages 1-2

```
08:12:43Z  node install
08:14:44Z  node v22.23.2 · pulling inputs
08:15:00Z  inputs: 2.2G mine · 433,449 corpus-text rows   <- independent count from source
08:15:00Z  STAGE 1 — slice
08:16:15Z  slice: 140000 pairs, sidecar 140000 rows (expect 140000 each)   BOTH GATES PASS
08:16:15Z  STAGE 2 — pulling cshl-QP2 weights (20260819-232838-train)
08:16:53Z  STAGE 2 — embedding 140,000 slice queries with cshl-QP2
```

**Stage 1 took 75 seconds.** The same build on the laptop reached 7.85 GB RSS,
drove the machine into swap, and died on a 4 GiB `writev`. That is the whole
argument for the doctrine in one measurement — and the line count is checked
independently for `train.jsonl` and `slice-slugs.jsonl` rather than inferred
from one of them, because the sidecar is what makes the ANCE join exact.

`433,449` corpus-text rows counted on the box matches the corpus exactly, so the
1.5 GB transfer is intact by content and not merely by byte count.

### An IAM gap closed while stage 1 ran

`write-eval-artifacts` and `write-model-artifacts` both carry
`s3:AbortMultipartUpload`; the `train/*` and `prep/*` grants I added to
`read-dburl` did not. The slice upload is 2.2 GB — multipart — and the CLI
issues an abort on a failed part. That is an AccessDenied at the *last* stage of
a 45-minute box, plus orphaned parts billing quietly afterwards: silent until
exercised, which is this program's signature failure. Fixed on the live role at
08:19Z (before the box reached the upload) and in `launch-prep.sh` for next time.

Verified in the same pass that re-putting `read-dburl` did not clobber the other
four inline policies — losing `write-eval-artifacts` is the incident LANE-WIN
recorded, and it is the grant the *train* box needs for its query-embed upload.

---

## 2026-08-20T08:22Z — the morning-report table (lead's addition (b)), built and cross-checked

`scripts/eval/final-table.mjs`. Both baselines in one table because two
different questions get asked of this program and they have different answers:

- **"did the fine-tune work?"** -> vs stock `bge-m3`, the model we started from,
  reported RELATIVE (that is where the 2.6x-style numbers live).
- **"are we competitive?"** -> vs `MedCPT`, the domain incumbent, reported as an
  ABSOLUTE Δ — the same units the McNemar tests are in, so the table and the
  significance tests cannot drift apart.

Run against the arms already scored, it reproduces the published digits with no
hand-entry:

```
medcpt+medcpt_ce   blended 0.6510   <- D8's stated system target, re-derived
cshl_qp+cshl_rr    blended 0.6160   <- LANE-RERANK's reported figure
cshl_qp2+cshl_rr   blended 0.6450   <- the -0.0060 tie, re-derived
```

That the blended arithmetic lands on 0.6510 independently is the check that the
family-weighted blend is the same blend D8's target is stated in.

**This deliverable is exactly what the metrics-shape bug would have broken.**
The generator reads `metrics[family].blended[metric]` generically, the same way
`fill-card.mjs` does. Against the pre-fix files every SYSTEM row — all five of
them, including both MedCPT baselines — would have rendered as `—`, because
`metrics.MESH` was `undefined` and the real numbers were buried under
`metrics.reranked`. The fix was not cosmetic; it is why the morning table has
system rows at all.

Target rows print `NOT YET SCORED` until `cshl_qp3` exists, so the table cannot
silently imply a result that has not been measured.

---

## 2026-08-20T08:32Z — a trap in MY OWN pre-staged commands, found before it fired

`paired-test.mjs` defaulted `DIR` to **`data/eval/cshl-eval-docdoc/results`** —
the doc->doc benchmark. My Q6/Q7 command lines above omitted `DIR`, copied from
LANE-WIN's snippets where it sat inside a `...` elision.

**Omitting it does not fail. It produces a confident, fully-guarded, wrong
answer.** Both benchmarks hold `<arm>.perquery.json` for the same arms with the
same 2,000 keys in the same order, so every assertion in the script passes.
Measured, not reasoned:

```
$ A=cshl_qp2 B=medcpt node scripts/eval/paired-test.mjs      # no DIR
  paired on 2,000 queries (same keys, same order — asserted)
  cshl_qp2  R@10 0.1960 · medcpt R@10 0.1790
  ΔR@10 +0.0170   exact McNemar p = 0.0397                   <- doc->doc. Wrong question.
```

versus the answer the report actually needs:

```
$ A=cshl_qp2 B=medcpt EVAL_VERSION=cshl-eval-2k node scripts/eval/paired-test.mjs
  benchmark: data/eval/cshl-eval-2k/results
  cshl_qp2  R@10 0.6150 · medcpt R@10 0.5900
  ΔR@10 +0.0250   exact McNemar p = 0.0159                   <- reproduces LANE-WIN
```

Same script, same arms, same "verified" framing, `p` significant both times,
nothing in the output naming which benchmark produced it. A pasted p-value
carried no provenance at all.

**Fix, at the class rather than the instance:** the default is gone —
`paired-test.mjs` now refuses to run without `DIR` or `EVAL_VERSION`, and echoes
the resolved directory as the first line of output, so every result carries its
own provenance. Per-family works the same way and reproduces the published MESH
row (`0.5238` vs `0.4569` on 1,241 queries). All Q6/Q7 command lines in this
document are corrected to pass `EVAL_VERSION=cshl-eval-2k`.
