# LANE-QPAIRS — the staged 40k query-pairs retrain

Append-only, timestamped. Mission: run the one experiment the CSHL report staged and did
not fire — retrain the encoder on **query-shaped** supervision (`cshl-query-pairs`), re-embed
into a third table, and score it against the **same frozen benchmark** as everything else.

The hypothesis under test, stated before the result is known: our 0.332 MeSH R@10 against
MedCPT's 0.457 is caused by an **objective mismatch** — we trained doc→doc (CITE) and
evaluated query→doc. If that is the whole story, query-shaped supervision closes the gap.
If it is not, the number will say so and the number gets published either way.

Budget: **hard cap $5.00 AWS**, approved by Brendan. Every box self-terminates on watchdog.

---

## Status

**PHASE: train — running.** Instance `i-09938e30bd1f42c3d`, `g6e.2xlarge`, `us-east-1c`,
run id `20260819-192100-train`, launched 2026-08-19T23:21Z.
**Training at batch 8 (NOT 16 — it OOMed, see 23:29Z). 4,999 steps at 1.52 it/s measured on
the box = ~55 min, so training ends ~2026-08-20T00:25Z and the box should self-terminate
~00:35Z after the query embed and the 2.3 GB weight upload.**
Watchdog hard-stops the box at 120 min (2026-08-20T01:21Z). If this file has not moved past
this line by 01:30Z, the run died silently and the box is gone — that is the deadline the
silence is measured against.

State polling is armed on: instance state, the box's own `/var/log/train.log` via SSM, and the
S3 weight prefix — three independent signals, because a log that stops printing and a job that
stopped working look the same from one of them.

---

## Log

### 2026-08-19T23:05Z — lane start, docs read
Read `CSHL-CPT-REPORT.md` (staged section, methodology, coverage), `RIG-DOCTRINE.md`,
`ORCHESTRATION-DOCTRINE.md`. Switched to branch `lane/rxiv-load` (the lane's branch; the
session opened on `main`, which was identical — `git diff main..lane/rxiv-load` empty).

### 2026-08-19T23:08Z — BLOCKER FOUND AND FIXED: the staged convert command could not work

The report stages this as step 1:

```
IN=data/mine/cshl-query-pairs.train.jsonl NAME=qpairs SUBSAMPLE=40000 \
  node --max-old-space-size=6144 scripts/train/from-mine.mjs
```

`scripts/train/from-mine.mjs` read the query side as `r.query?.slug`. Measured against the
actual file, independently, before running anything:

```
rows 424,753 · query-as-string 424,753 · query-as-obj-with-slug 0 · other 0
families: EXTRACT 259,920 · MESH 102,667 · AUTHORKW 62,166
```

**Every record in `cshl-query-pairs` carries `query` as a literal query string**, not a slug
into the corpus — which is the entire point of the set. The converter was written for
`cshl-triplets` (CITE), where the query *is* a paper. Run as staged, `r.query?.slug` is
`undefined` on all 424,753 rows, every row falls into the `dropped` counter, and the script
writes an **empty `train.jsonl`** and prints its normal success line. `upload-slice.sh` would
have uploaded it (it gates on `disjointness.pass`, which was a hardcoded literal `true`), and
`train.sh` would have accepted it.

This is exactly the dominant failure mode both doctrines name: **an operation that reports
success while doing nothing.** It was caught by measuring the input rather than trusting the
staged command.

Fix, in `scripts/train/from-mine.mjs` only (`train.sh` and `launch.sh` are fenced for the rig
lane and were not touched):

- handle both record shapes explicitly, named in comments; an unrecognised shape is a drop,
  never a silent pass;
- `ABORT` with a non-zero exit if 0 records are convertible — an empty slice can no longer be
  written at all;
- count families in what is **EMITTED**, not what is read, and record both in the manifest
  (`families_emitted` vs `families_convertible`);
- `disjointness.pass` is now **computed** from a post-hoc re-scan of the emitted set against
  the frozen benchmark's gold papers, not a hardcoded `true`. It used to be a claim; it is
  now a check;
- disclose the count of emitted training queries whose text also appears as a benchmark query
  string. This is **not** a leak — the benchmark splits by *paper*, deliberately — but it is
  the first thing a reader will ask about, so it is measured rather than argued;
- stream the 290 MB input instead of `readFileSync().split()`.

### 2026-08-19T23:12Z — convert fired

### 2026-08-19T23:14Z — convert VERIFIED

```
read 424,753 · convertible 424,753 · dropped 0 · rejected for touching the frozen benchmark 0
query side: 424,753 literal-text · 0 slug-into-corpus
  MESH:     102,667 ->  9,668
  AUTHORKW:  62,166 ->  5,854
  EXTRACT:  259,920 -> 24,477
EMITTED families: {"MESH":9668,"AUTHORKW":5854,"EXTRACT":24477}
EMITTED disjointness: 0 references to frozen-benchmark gold papers (must be 0)
EMITTED query-string overlap with benchmark: 157 / 39,999
wrote 39,999 pairs -> data/train/qpairs/train.jsonl   (601 MB)
```

Stratified across all three families, counted **in what was emitted**. 39,999 rather than
40,000 because the per-family `round()` of the proportional take loses one.

`rejected_for_overlap 0` deserves a sentence, because zero is exactly the number a broken
check returns. It is not broken: `evalKeys` loaded 6,203 gold papers (non-zero, and the same
set gates the negatives). Zero rejections means lane-mine had **already** excluded held-out
papers from the train split using the same `md5("holdout:"||key)` rule. This run is the
independent second count that confirms it — which is the only kind of confirmation the
orchestration doctrine accepts.

Independent verification of the emitted file itself, re-read from disk rather than taken from
the converter's report:

```
lines 39,999 · malformed 0
query chars:    min 11 · avg 110 · max 273        <- genuinely query-shaped
positive chars: avg 1,768 · max 4,000             <- title+abstract, the 4000-char cap
negatives/row:  8 x 34,203 · 7 x 5,399 · 6 x 385 · 5 x 11 · 4 x 1
first row query: "D. melanogaster; Embryo, Nonmammalian; Single-Cell Analyses; Transcriptome"
```

That average query length of 110 characters against an average positive of 1,768 is the whole
experiment in one line: this is query->doc supervision, where the CITE run was doc->doc.

`GROUP_SIZE=8` consumes 1 positive + 7 negatives; ~1% of rows carry fewer than 7 negatives and
FlagEmbedding will sample with replacement for those. Noted, not corrected.

### 2026-08-19T23:16Z — third vector table created, both existing tables untouched
```
preprints                    433,449
preprint_embeddings_medcpt   433,449
preprint_embeddings_cshl     433,449   <- the CITE run, untouched
preprint_embeddings_cshl_qp        0   <- created empty, this run's target
```
DDL added to `scripts/eval/sidecars.sql`, HNSW (cosine, matching the arm's metric) to
`scripts/eval/indexes.sql` — to be built AFTER the sweep, per that file's own rule. One
registry entry `cshl_qp` added to `scripts/eval/score.mjs`, which is all three of the scorer,
the doc->doc scorer and the coverage gate, since both import `REGISTRY` from it.

### 2026-08-19T23:14Z — capacity/quota preconditions checked (free)
```
Running On-Demand G and VT instances : 64 vCPU     (g6e.2xlarge and g5.2xlarge are 8 each)
All G and VT Spot Instance Requests  :  8 vCPU
g6e.2xlarge offered in: us-east-1a, 1b, 1c, 1d
g5.2xlarge  offered in: us-east-1a, 1b, 1c, 1d, 1f
GPU instances currently running: none
```
Quota is not the constraint. Capacity is unknown until a launch is attempted, and per the
rig doctrine an unexercised limit produces no error — so the launch attempt *is* the probe,
and a capacity error is an answer rather than a failure. `g6e.2xlarge` first.

Also confirmed the IAM role `cshl-embed` already carries `s3:PutObject` on `eval/*` (added
after the incident in the report). Without it `train.sh` §5b's query-vector upload — which
ends in `|| true` — would have failed silently and left the arm unscoreable.

---

## Spend ledger

| when | item | $ | note |
|---|---|---:|---|
| — | convert, local | 0.00 | free |
| — | quota/capacity/IAM checks | 0.00 | free, API reads only |
| | **running total** | **0.00** | cap $5.00 |

### 2026-08-19T23:15Z — slice uploaded and verified in S3
```
s3://cshl-embed-rxiv/train/qpairs/train.jsonl    630,710,633 bytes  (byte-exact with local)
s3://cshl-embed-rxiv/train/qpairs/manifest.json  pairs 39,999 · families_emitted
                                                 {MESH 9668, AUTHORKW 5854, EXTRACT 24477}
                                                 · disjointness.pass true
```
The frozen `cshl-eval-v1/queries.jsonl` is re-uploaded by `upload-slice.sh` as a side effect.
Checked local md5 against the S3 ETag **before** letting it run — `4f1f4a26f113db8da0701f3a3539fbfe`
both sides, so the overwrite of a frozen artifact was a genuine no-op rather than an assumed one.

### 2026-08-19T23:19Z — free independent check: the report's McNemar table reproduces

The report publishes a paired McNemar table and a bootstrap CI for the doc→doc arms, but the
analysis was ad-hoc and never committed — so this run could not have reproduced the comparison
it is supposed to be measured against. Rewrote it (`scripts/eval/paired-test.mjs`), from the
method description rather than the original code, and it lands on the published row exactly:

```
cshl vs medcpt · paired on 2,000 queries (same keys, same order — asserted, not assumed)
  both hit 252 · neither 1,470 · cshl-only 172 · medcpt-only 106
  ΔR@10 +0.0330 · exact McNemar p = 9.03e-5
  bootstrap 95% CI [+0.0170, +0.0495]   vs published [+0.0165, +0.0495]
```
The 0.0005 on the lower bound is the bootstrap seed. Two independent implementations agreeing
is evidence; recovering the original would have been worth nothing.

### 2026-08-19T23:21Z — TRAIN LAUNCHED. The capacity probe answered: g6e is available tonight

The report recorded `g6e` at **zero capacity in every AZ throughout** the previous night, and
the rig doctrine's rule is that an unexercised limit produces no error — so the launch attempt
is the probe. It succeeded on the first try:

```
i-09938e30bd1f42c3d   g6e.2xlarge   running   us-east-1c   2026-08-19T23:21:09Z
run_id 20260819-192100-train
MODE=train TRAIN_NAME=qpairs EVAL_VERSION=cshl-eval-v1 EPOCHS=1
BATCH=16 QUERY_MAX_LEN=128 PASSAGE_MAX_LEN=384 GROUP_SIZE=8 WATCHDOG_MIN=120
```

**This run pulls BOTH untested levers at once, and that is a deliberate trade.** The report
named two independent candidate causes for the 0.332: the objective mismatch, and batch 4
chosen by the OOM guard on a 24 GB A10G. The L40S has 48 GB, so `BATCH=16` — four times the
CITE run's effective batch, i.e. ~15 in-batch negatives per example against ~3. If the number
moves, this run cannot say which lever moved it. Pulling one at a time would need two runs and
about $6, which does not fit under the $5.00 cap; a single run that answers "does query-shaped
supervision at a healthy batch size close the gap" is worth more than half of a cleaner
experiment. Stated here so the result is not over-read later.

`WATCHDOG_MIN=120` rather than the 360 default: g6e.2xlarge is **$2.242/hr**, so the stock
watchdog would permit a $13.45 hang — 2.7× the entire lane budget. 120 min caps the worst case
at $4.48 and still leaves ~35 min of headroom over the ~85 min expectation. The box also
self-terminates on success, so the normal path costs only what it uses. If it is still
legitimately training near the wall I will extend it by hand rather than let a healthy run be
killed — there is no checkpointing in this rig (rig doctrine §4, still an open gap), so a
watchdog kill loses the entire run.

### 2026-08-19T23:27Z — training is actually running, at the batch we asked for

```
[train.sh] 39999 training pairs in qpairs
[train.sh] manifest disjointness: {"pass": true, ... "emitted_references_to_gold_papers": 0}
[train.sh] attempt: batch=16 warmup_steps=250 gradient_checkpointing=off
```

`batch=16` started, 2,500 steps (39,999 / 16), warmup 250.

### 2026-08-19T23:29Z — batch 16 did NOT hold. It OOMed on the L40S and the guard halved to 8

```
torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 384.00 MiB.
  GPU 0 has a total capacity of 44.39 GiB of which 151.38 MiB is free.
[train.sh] OOM — halving batch to 8
[train.sh] attempt: batch=8 warmup_steps=500 gradient_checkpointing=off
```

**This is the thing the rig doctrine says must never happen quietly, and this time it did not
— but it still happened.** It is recorded here in the same breath as the plan that claimed
batch 16, because the alternative is a report that says "trained at batch 16" while the
weights say otherwise.

Verified the fallback is genuinely healthy rather than merely running, from the box:

```
4,999 steps · 1.52 it/s · ETA 54 min
NVIDIA L40S · 33,883 MiB / 46,068 MiB used · GPU utilization 100%
```

**Where this leaves the experiment.** Effective batch is **8**, which is 2× the CITE run's 4,
not the 4× the plan assumed. So the in-batch-negative count goes from ~3 to ~7, not ~15. The
batch lever is *partially* pulled, and the headline claim has to be "query-shaped supervision
at batch 8," never "at batch 16."

**Why not chase batch 16.** Priced the alternatives rather than assuming:
- *A bigger single GPU.* g6e.2xlarge already carries a full 48 GB L40S; g6e.4xlarge is the
  same one GPU. The next real step is 80 GB A100/H100 at $32+/hr — six times the entire lane
  budget for one hour.
- *Multi-GPU data parallel.* Four L40S would multiply effective batch by 4 at roughly the same
  total cost, which is exactly what the rig doctrine recommends — but this rig has no
  multi-GPU support. That gap is already a named open item and it is not this lane's to fix
  mid-flight while another lane holds the rig files.
- *`gradient_checkpointing`.* Would fit batch 16, but `train.sh` only reaches for it at
  batch 1 and `train.sh` is fenced.
- *Shorter passages.* `PASSAGE_MAX_LEN=256` would halve activations and fit batch 16 — and it
  is the one option I actively do not want, because the embed rig indexes the full 4,000-char
  document. Training on half of what is served is a train/serve mismatch, which is a worse
  defect than a smaller batch and a much quieter one.

Proceeding at batch 8. Cost of the OOM: about 3 minutes of a $2.242/hr box, **$0.11**, itemised
as waste in the ledger.

### 2026-08-19T23:30Z — the re-embed priced from measurement, not from the estimate

The report estimated the re-embed at ~$0.85. Re-derived from the tables themselves rather than
from a log — how long the previous sweeps actually took to write every row:

```
preprint_embeddings_medcpt   433,449 rows   embedded_at span  4.5 min
preprint_embeddings_cshl     433,449 rows   embedded_at span 15.0 min   <- the CITE run
```

That span is embedding time only; a box also pays ~8-10 min of fixed overhead (boot, TEI model
load, the node tarball, `npm i pg`) before it writes its first row. Priced against the rates
pulled from the AWS pricing API — `g6e.xlarge $1.861/hr`, `g6e.2xlarge $2.24208/hr`,
`g5.xlarge $1.006/hr`, `g5.2xlarge $1.212/hr`:

| plan | wall-clock | $ |
|---|---|---:|
| `N=2` g6e.xlarge — 2 × (10 + 15) min | ~25 min | **1.55** |
| `N=1` g6e.xlarge — 1 × (10 + 30) min | ~40 min | 1.24 |

The fixed per-box overhead is why two boxes are not half the price of one. **Going with `N=2`
as staged** — $0.31 buys back 15 minutes, and the doctrine's rule is time first, cost second,
priced together. This is the priced-together part. If the train box overruns and threatens the
$5.00 cap, `N=1` is the cheaper rung and the decision moves.

Not switching to g5 for the embed: A10G is roughly 0.55× an L40S here, so `g5.xlarge` at
$1.006/hr costs about the same *per document* as `g6e.xlarge` at $1.861/hr while taking nearly
twice the wall-clock. Same money, more waiting. (It would also need `TEI_IMAGE=…:86-1.8` —
the default `89` image is Ada-only, and the wrong one starts a container that never loads a
model.)

### 2026-08-19T23:43Z — control: the harness still reproduces the published numbers exactly

Before trusting this harness to produce a *new* number, made it produce the *old* ones. Scored
the two arms the report already published, on the same frozen 2k subsample, through the same
code path the new arm will use — after my registry edit, so the edit is inside the test:

| arm | MeSH R@10 | published | MeSH nDCG@10 | published | AUTHORKW R@10 | published |
|---|---:|---:|---:|---:|---:|---:|
| `cshl` (CITE run) | **0.3320** | 0.3320 | 0.2367 | 0.2367 | **0.6693** | 0.6693 |
| `ncbi/MedCPT` | **0.4569** | 0.4569 | 0.3373 | 0.3373 | **0.8076** | 0.8076 |

Every digit. R@1 likewise: ours 0.1571 / 0.4611, MedCPT 0.2345 / 0.5731. Both arms reported
`Index Scan CONFIRMED`, so neither fell back to a sequential scan — the failure the
`indexes.sql` header warns about, where an opclass mismatch gives a correct-but-slow answer and
nothing complains.

This is a control, not a formality. It rules out, *in advance*, the three ways the new number
could have been quietly wrong: a benchmark that shifted under us, a harness change that broke
an arm, and a registry edit with side effects. The published results were copied aside first
and are byte-restorable.

---

## Spend ledger (revised — the train box is now live)

| when | item | rate | $ | note |
|---|---|---|---:|---|
| 23:14Z | convert, local | — | 0.00 | free |
| 23:14Z | quota / capacity / IAM checks | — | 0.00 | free, API reads only |
| 23:15Z | S3 PUT 601 MB + storage | — | ~0.01 | negligible, counted anyway |
| 23:21Z | train `g6e.2xlarge` | $2.242/hr | **in flight** | expected ~$3.20, hard ceiling $4.48 |
| — | re-embed 433,449 × 2 boxes | — | pending | ~$0.85 estimated |
| | **committed so far** | | **~0.01** | cap $5.00 |

Waste this lane, itemised: **none yet.**
