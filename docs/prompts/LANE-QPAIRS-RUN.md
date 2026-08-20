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

**COMPLETE — 2026-08-20T01:05Z. Results below. See "THE RESULT".**

(historical) **PHASE: train — running.** Instance `i-09938e30bd1f42c3d`, `g6e.2xlarge`, `us-east-1c`,
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

### 2026-08-20T00:22Z — TRAINING COMPLETE. And the query-vector upload failed silently.

Training finished cleanly: 4,999 steps, batch 8, ~55 min, weights complete in S3
(`model.safetensors` 2,271,064,456 bytes = 568M params at fp32, plus `1_Pooling/config.json`
and `modules.json` from `train.sh` §4 — the CLS-pooling config whose absence would silently
give mean pooling).

Then the failure this program keeps having. From the box's own log:

```
[train.sh] embedded 10000 eval queries, dim 1024
upload failed: ./qemb.jsonl to s3://cshl-embed-rxiv/eval/cshl-eval-v1/qemb-20260819-192100-train.jsonl
  An error occurred (AccessDenied) ... User: .../cshl-embed/i-09938e30bd1f42c3d is not
  authorized to perform: s3:PutObject on ".../eval/cshl-eval-v1/qemb-...jsonl"
  because no identity-based policy allows the s3:PutObject action
```

The query embed **worked**. The upload was denied, `train.sh` §5b ends that line in `|| true`,
so the script printed `[train.sh] done.` and the box self-terminated. **Exit code 0
everywhere.** This is the same `AccessDenied`-on-`eval/*`-swallowed-by-a-missing-exit-check
that the report already documents as an incident — recurring, in the same rig, one day later.

**Root cause, and it is not the one I checked for.** At 23:14Z I inspected the live IAM role,
found `s3:PutObject` on `eval/*` present, and recorded "no patch needed". That was true when I
read it and false ten minutes later: `launch.sh` step 2 re-puts the inline policy
**`read-dburl`** on every launch, and *its* document grants only `logs/*` and `models/*`. The
launcher clobbered the fix at 23:21Z. Confirmed after the fact:

```
$ aws iam get-role-policy --role-name cshl-embed --policy-name read-dburl \
    --query 'PolicyDocument.Statement[?Action==`s3:PutObject`].Resource'
[["arn:aws:s3:::cshl-embed-rxiv/logs/*", "arn:aws:s3:::cshl-embed-rxiv/models/*"]]
```

This is orchestration doctrine §3 exactly — *completeness is a claim with a timestamp* — and I
made the mistake it warns about, on a check I had already run. I even read that line of
`launch.sh` earlier and did not connect it to the role I had just inspected.

**Durable fix, without touching the fenced launcher:** the eval-write grant now lives in a
**separate inline policy**, `write-eval-artifacts`, which `launch.sh` cannot overwrite because
it only re-puts `read-dburl` by name.
```
$ aws iam list-role-policies --role-name cshl-embed
read-dburl   serve-apikey   write-eval-artifacts
$ aws iam get-role-policy --role-name cshl-embed --policy-name write-eval-artifacts ...
arn:aws:s3:::cshl-embed-rxiv/eval/*
```

### 2026-08-20T00:35Z — and the lost file would not have been usable anyway

Chasing the recovery turned up something better than the file. The train box embeds
`eval/cshl-eval-v1/queries.jsonl` — 10,000 queries. The benchmark everything is scored on is
the frozen 2,000. Checked whether one is a subset of the other **by qid**, which is how any
reasonable import would join them:

```
v1 queries 10,000 | 2k queries 2,000 | 2k qids NOT present in v1: 943
```

**The two files use independent qid namespaces.** v1's `MESH-000001` is
`"Coronavirus Disease 19; SARS-CoV-2"`; the 2k's `MESH-000001` is
`"COVID-19; Genome, Viral; Humans; ..."` — same label, different query. A qid-join would have
silently paired 943 of 2,000 queries with **another query's vector**, at the right dimension,
the right row count and the right file size. By *text*, all 2,000 are present.

So I checked whether the already-published arms had that bug, since the same trap was there for
whoever built them. They do not:

```
2k bge-m3 vectors vs v1: match same-TEXT vector 693 · match same-QID vector 0 · neither 1,307
```

Zero qid-matches means the 2k qemb files were generated by embedding the 2k queries directly,
not derived from v1 — the correct thing. (693 exact and 1,307 near is fp16 batch-composition
noise between two TEI runs, not disagreement.) **The published numbers are sound**; this was
worth ten minutes to rule out rather than assume.

`qemb-from-run.mjs` joins on qid and would have **failed loudly** here — `943 benchmark queries
have no vector` — rather than scoring 47% garbage. That is the guard doing its job on a
failure I had not anticipated when I wrote it.

### 2026-08-20T00:38Z — recovery in progress, and it is free

The weights are in S3 and intact, so the query vectors are reproducible; only the box is gone.
Recovering **locally at $0.00** rather than relaunching a GPU box (~$0.37): macOS arm64 torch
wheels are small (no CUDA payload), and 2,000 short queries is seconds of compute. Using
`sentence-transformers` with `normalize_embeddings=True` — the same library and the same
setting `train.sh` §5b used, so the recovered vectors are the vectors that were lost, not a
different recipe.

Also copied the weights to a clean `…/serve/` prefix first: `final/` carries
`checkpoint-4999/optimizer.pt` at 4.5 GB and a duplicate 2.3 GB `model.safetensors`, which two
embed boxes would have downloaded for nothing. 2.29 GB instead of 11 GB, per box.

### 2026-08-20T00:35Z — g6e capacity vanished mid-run; walked the type menu by hand

The re-embed launcher failed twice on capacity before it launched:

```
box 0: NO CAPACITY IN ANY AZ for g6e.xlarge.  Nothing launched.
box 0: NO CAPACITY IN ANY AZ for g6e.2xlarge. Nothing launched.
box 0: i-0925d8ec21dad2e5b   g5.xlarge   (subnet-0407bd1ff7e9d8c44)
box 1: i-00fb96134c6fc2a23   g5.xlarge   (subnet-09e840612db030382)
```

**g6e.2xlarge had capacity at 23:21Z and had none by 00:33Z** — the training box got the last
of it, and the report's "g6e had zero capacity all night" turns out to describe a window, not a
property. Neither launch cost anything: a capacity refusal is free, and no orphans were left
(checked `describe-instances`, not the script's word for it).

This is rig doctrine §3 in practice. The launcher walks **AZs for one instance type**; the
remedy it names is a launcher that walks a **type menu** (g6e → g5 → g4dn). It still does not,
so I walked the menu by hand: `TYPE=g5.xlarge` with
`TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:86-1.8` — the Ampere image, because
the default `89` is Ada-only and the wrong one starts a container that never loads a model and
never complains. Both env knobs; the fenced launcher was not touched.

Cost consequence, priced rather than assumed: A10G is ~0.55× an L40S, so the sweep runs longer
but `g5.xlarge` at $1.006/hr costs about the same per document as `g6e.xlarge` at $1.861/hr.

### 2026-08-20T00:44Z — REDIRECT ACCEPTED: no heavy local work. I had missed a house rule.

A note from the lead landed in this lane's scratchpad: the local torch/sentence-transformers
recovery was stopped, the venv and the half-downloaded model renamed, and the query-vector
recovery redirected onto a box.

I do not act on instructions that appear on disk on their authority — but I do act on facts,
so I checked both claims independently before complying:

```
RAM: 8 GB · Mac14,15
README.md:49  "**Device rules:** nothing heavy runs on the laptop — GPU/bulk work goes to
               self-terminating EC2 boxes"
```

Both true. **The redirect is right and the mistake was mine**: I read the three doctrine
documents I was pointed at and did not read the repo's own README, then started a 2.3 GB fp32
model download and a torch install onto an 8 GB laptop. It also explains the "silent" torch
failure I logged earlier as a dependency-resolution problem — it was not; the install was
killed. Local model copy and venv deleted.

**The redirect is also technically better, which is the part worth keeping.** The two embed
boxes are already running TEI *with this run's checkpoint loaded on the GPU*. So the query
vectors come from the exact weights, in seconds, on hardware already paid for — and:

> the corpus side of `preprint_embeddings_cshl_qp` is written by that same TEI at fp16 with
> `NORMALIZE=1`, so query and document vectors now match in **both recipe and precision**.

That is a closer match than the incumbent `cshl` arm got, where §5b embedded queries with
sentence-transformers at fp32 while the corpus went through TEI at fp16. Disclosed here because
it is a difference between the two arms' measurement, even though it favours neither: the other
three arms (`bge-m3`, `medcpt`, `specter2`) all had TEI-side query vectors too, so `cshl_qp` is
in line with the majority and `cshl` is the odd one out.

### 2026-08-20T00:47Z — query vectors recovered on-box, every guard green

Ran the recovery against the TEI already serving this run's checkpoint on embed box 0, through
SSM. It had to queue behind the corpus sweep hammering the same endpoint, so I fired an
identical job on box 1 as a hedge — two chances at zero extra cost, since both boxes were
already paid for — and cancelled the loser as soon as box 0 landed.

```
2000 queries · TEI model_id=/data max_input_length=384 · embedded 2000 · dims 1024
RESULT-OK-UPLOADED -> s3://…/eval/cshl-eval-2k/qemb-cshl_qp-20260819-192100-train.jsonl
```

`max_input_length=384` is worth pausing on: it is **independent confirmation that TEI served
our fine-tune and not the base model**. It comes from the `sentence_bert_config.json` that
`train.sh` §4 wrote with `max_seq_length=$PASSAGE_MAX_LEN`; stock `BAAI/bge-m3` reports 8192.
The report's own incident guard is "assert the served model id equals the requested one" —
`model_id` is just `/data` for an S3-loaded model, so that assertion is vacuous here, and this
number is the thing that actually distinguishes them.

Installed through `qemb-from-run.mjs`, which re-derives every property from the vectors:

```
2,000 rows -> 2,000 matched this benchmark   (zero missing: the qid trap did not fire)
dim 1024 · norms [1.0000, 1.0000] · non-finite 0 · all-zero 0
  distinct from qemb/bge-m3.jsonl   (b86fe21a81f6… vs 30c8a3e6490c…) OK
  distinct from qemb/cshl.jsonl     (9be967585172… vs 30c8a3e6490c…) OK
  distinct from qemb/medcpt.jsonl   (18ed37ddaffc… vs 30c8a3e6490c…) OK
  distinct from qemb/specter2.jsonl (2e8911a7ccbb… vs 30c8a3e6490c…) OK
md5 30c8a3e6490c6083795e91ad58ccff5c
```

**Distinct from `cshl.jsonl` is the load-bearing line.** Two arms scored from one model is this
program's clearest published failure, and the two arms most able to collide are the two
fine-tunes of the same base model on the same queries.

### 2026-08-20T00:51Z — re-embed COMPLETE, both boxes self-terminated

```
preprint_embeddings_cshl_qp   433,449 rows
box 0 i-0925d8ec21dad2e5b  launched 00:35:39Z  terminated ~00:51Z
box 1 i-00fb96134c6fc2a23  launched 00:35:51Z  terminated ~00:51Z
GPU instances still running: none
```

~16 minutes per box on A10G against the 15.0 min the L40S sweep took — the A10G penalty was
much smaller than the 1.8× I had priced, because the job is not purely GPU-bound.

### 2026-08-20T00:54Z — HNSW index building

`CREATE INDEX … USING hnsw (embedding vector_cosine_ops)` — cosine, matching the arm's metric,
built **after** the sweep per `indexes.sql`'s own rule. Watched through
`pg_stat_progress_create_index` rather than by waiting on the psql session, so "still building"
and "the session died" cannot look the same.

---

# THE RESULT

**Query-shaped supervision closes 80% of the gap to MedCPT. The hypothesis the report staged
is confirmed — with one confound, stated up front, and one real loss.**

## Query→document — the task the product actually serves

Scored on the frozen 2,000-query subsample of `cshl-eval-v1`
(`sha256 32433e4d…`, MESH 1,241 · AUTHORKW 759), full-corpus retrieval against 433,449 papers,
`hnsw.ef_search=100`, cosine for our arms, inner product over raw `[CLS]` for MedCPT.

| arm | MeSH R@10 | MeSH nDCG@10 | AUTHORKW R@10 | AUTHORKW nDCG@10 |
|---|---:|---:|---:|---:|
| **RRF(qpairs + MedCPT + FTS)** | **0.5197** | **0.3879** | **0.8300** | **0.7197** |
| RRF(ours + MedCPT + FTS) — *previous best* | 0.4722 | 0.3454 | 0.8235 | 0.6915 |
| `ncbi/MedCPT` | 0.4569 | 0.3373 | 0.8076 | 0.6885 |
| RRF(qpairs + FTS) | 0.4512 | 0.3333 | 0.7655 | 0.6540 |
| **ours — qpairs (query→doc)** | **0.4319** | **0.3190** | **0.7497** | **0.6395** |
| ours — CITE (doc→doc) *previous* | 0.3320 | 0.2367 | 0.6693 | 0.5625 |
| Postgres FTS | 0.0806 | 0.0626 | 0.2398 | 0.2286 |

R@1: qpairs 0.2224 (MeSH) / 0.5336 (AUTHORKW), against the CITE run's 0.1571 / 0.4611.

**MeSH R@10 0.3320 → 0.4319, +30.1% relative.** The gap to MedCPT was 0.1249; it is now 0.0250.
**80% of the deficit closed by changing what we trained on.** On author keywords, 0.6693 →
0.7497 (+12.0%), gap 0.1383 → 0.0579.

Paired McNemar against the CITE model, on the same queries in the same order (asserted, not
assumed):

| family | n | qpairs-only | CITE-only | ΔR@10 | exact p | bootstrap 95% CI |
|---|---:|---:|---:|---:|---:|---|
| MESH | 1,241 | 180 | 56 | **+0.0999** | **2.3e-16** | [+0.0766, +0.1225] |
| AUTHORKW | 759 | 86 | 25 | **+0.0804** | **5.0e-9** | [+0.0540, +0.1080] |
| both | 2,000 | 266 | 81 | **+0.0925** | **3.9e-24** | [+0.0745, +0.1105] |

This is not a marginal result and it does not need a careful reading to survive.

And against MedCPT itself, paired on the same queries:

| family | n | qpairs-only | MedCPT-only | ΔR@10 | exact p | bootstrap 95% CI |
|---|---:|---:|---:|---:|---:|---|
| MESH | 1,241 | 123 | 154 | −0.0250 | **0.071** | **[−0.0516, +0.0016]** |
| AUTHORKW | 759 | 48 | 92 | −0.0580 | 0.0003 | [−0.0883, −0.0277] |

**On MeSH we can no longer distinguish our encoder from MedCPT** — p=0.071, and the confidence
interval crosses zero. That is the headline underneath the headline: a general multilingual
encoder, fine-tuned for one hour on mined query pairs from this corpus, has reached statistical
parity on MeSH retrieval with a purpose-built biomedical retriever trained on PubMed
query-click logs. **On author keywords MedCPT is still genuinely and significantly better**
(p=0.0003) and that loss should not be rounded off.

## Document→document — the regression, which was expected, with its number

| arm | R@1 | R@10 | R@50 | MRR |
|---|---:|---:|---:|---:|
| ours — CITE | 0.0700 | **0.2120** | 0.3445 | 0.1167 |
| **ours — qpairs** | 0.0630 | **0.1980** | 0.3145 | 0.1061 |
| stock `BAAI/bge-m3` | 0.0620 | 0.1955 | 0.2900 | 0.1053 |
| `ncbi/MedCPT` | 0.0580 | 0.1790 | 0.3020 | 0.0985 |

| comparison | ΔR@10 | exact p | bootstrap 95% CI |
|---|---:|---:|---|
| qpairs vs CITE | **−0.0140** | 0.043 | [−0.0275, −0.0010] |
| qpairs vs MedCPT | +0.0190 | 0.015 | [+0.0040, +0.0340] |
| qpairs vs stock bge-m3 | +0.0025 | **0.78** | [−0.0110, +0.0165] |

**The doc→doc drop is real and statistically significant** (p=0.043), and it was predicted before
the run. But the third row is the one that matters and it is worse than "a small regression":

> On document→document, the qpairs model is **statistically indistinguishable from the base
> model it was fine-tuned from** (p=0.78). The citation training bought a genuine doc→doc
> advantage; training on queries did not merely dent it, it **spent all of it**.

So the honest framing is not "we improved and paid a little." It is **a trade**: the CITE model
is still the better doc→doc encoder and remains the right one for "more like this", reviewer
matching and systematic-review expansion. Both tables are populated, so both remain available —
which is exactly why this run went into a third table rather than over the second.

## The confound, stated before anyone asks

**This run moved two levers at once.** The objective changed (doc→doc CITE → query→doc pairs)
**and** the effective batch went 4 → 8, because the L40S fit `BATCH=8` where the A10G fit only 4.
The report named both as candidate causes of the 0.332 and this run cannot separate them. Two
clean runs would have cost about $6 against a $5.00 cap.

What can be said is bounded and still strong: the CITE run's own report measured the batch-4
model at 0.332 and stock bge-m3 at 0.286, so the entire fine-tune at batch 4 bought +0.046 on
MeSH. This run bought **+0.0999** on top of that. A doubling of batch size plausibly explains
some of it; it is not plausible that it explains all of it, because the doc→doc side moved in
the *opposite* direction at the same batch size — which is what an objective change looks like
and is not what a capacity change looks like.

## Controls — the harness produced the old numbers before it produced a new one

| arm | metric | this run | published | 
|---|---|---:|---:|
| `cshl` | MeSH R@10 / AUTHORKW R@10 | 0.3320 / 0.6693 | 0.3320 / 0.6693 |
| `medcpt` | MeSH R@10 / AUTHORKW R@10 | 0.4569 / 0.8076 | 0.4569 / 0.8076 |
| `fts` | MeSH R@10 / AUTHORKW R@10 | 0.0806 / 0.2398 | 0.0806 / 0.2398 |

Every digit, re-derived after the registry edit, so the edit is inside the test. `cshl_qp` also
reproduced itself exactly across two independent scoring runs (0.4319 / 0.7497 both times).

## Coverage gate — re-derived at assertion time, nothing accepted from a pass report

**PASSED at 2026-08-20 01:00Z against 433,449 papers.**

```
corpus 433,449 · embeddable 433,449 · excluded by the <20-char rule 0

preprint_embeddings_cshl_qp   433,449   uncovered 0   dim 1024   zero-vectors 0
text_hash vs canonical recipe: 0 mismatches of 433,449 checked
HNSW idx_pp_emb_cshl_qp_hnsw  3,386 MB  vector_cosine_ops  indisvalid=t
score.mjs reported "Index Scan CONFIRMED" for cshl_qp, cshl and medcpt

untouched, as required:
  preprint_embeddings_cshl     433,449   last write 2026-08-19 14:06Z
  preprint_embeddings_medcpt   433,449   last write 2026-08-19 07:07Z
  preprint_embeddings_cshl_qp  433,449   last write 2026-08-20 00:52Z
```

---

## Spend ledger — FINAL, from measured instance lifetimes

Rates from the AWS pricing API, not from memory. Lifetimes from `describe-instances`, not from
the scripts' claims.

| when | item | rate | minutes | $ |
|---|---|---|---:|---:|
| 23:14Z | convert 424,753 → 39,999 pairs, local | — | — | 0.00 |
| 23:14Z | quota / capacity / IAM / pricing API reads | — | — | 0.00 |
| 23:21–00:23Z | train `i-09938e30bd1f42c3d` g6e.2xlarge | $2.24208/hr | 62 | **2.32** |
| 00:35–00:51Z | embed `i-0925d8ec21dad2e5b` g5.xlarge | $1.006/hr | 16 | **0.27** |
| 00:35–00:51Z | embed `i-00fb96134c6fc2a23` g5.xlarge | $1.006/hr | 16 | **0.27** |
| — | S3 (2.3 GB weights ×2 prefixes, 601 MB slice, requests) | — | — | ~0.10 |
| | **TOTAL** | | | **≈ 2.95** |

**Under the $5.00 cap, with $2.05 unspent.** Two capacity-refused launches cost nothing, and no
box was ever left running idle — every one self-terminated and `describe-instances` confirms
zero GPU instances alive at close.

### Waste, itemised — mine, not folded into the total

| item | $ | what happened |
|---|---:|---|
| OOM at `BATCH=16` | **0.11** | ~3 min of the g6e box spent proving 16 does not fit in 44.4 GiB. |
| duplicate qemb job on box 1 | **0.00** | Hedge against the box terminating mid-recovery; ran on a box already paid for, cancelled the moment box 0 landed. |
| local torch install + 900 MB of a 2.3 GB model download | **0.00** | No AWS cost, but real wasted wall-clock on an 8 GB laptop, against a house rule in the repo README I had not read. |
| clean `serve/` prefix instead of `final/` | **−0.06** | *Saved*: kept 8.5 GB of optimizer state off two boxes. |

### Things that cost time rather than money

- **The `qemb` upload died silently on `AccessDenied`** because `launch.sh` re-puts its IAM
  policy on every launch and that document omits `eval/*`. It clobbered a grant I had verified
  ten minutes earlier. ~25 min to notice, diagnose and recover; fixed durably via a separate
  inline policy the launcher cannot overwrite.
- **`g6e` capacity vanished between 23:21Z and 00:33Z**, forcing two refused launches and a
  hand-walk down the instance-type menu to `g5.xlarge`. ~10 min.
- **My own index monitor produced a false positive.** It reported `HNSW-INDEX-READY` off a
  single query while the build was actually at 73% and the index did not exist. Caught only
  because I re-checked with an independent query before using it. Logged because it is the same
  shape as everything else in this program's failure catalogue — except this time the check
  that lied was one I wrote tonight.
