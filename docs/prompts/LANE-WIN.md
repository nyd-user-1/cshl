# LANE-WIN — beat ncbi/MedCPT head-to-head on the frozen benchmark

Append-only, timestamped. Mission: **beat MedCPT on both families** on the frozen 2,000-query
benchmark (`cshl-eval-2k`). Targets, fixed before any number was produced:

| target | MedCPT | must exceed |
|---|---:|---:|
| MeSH R@10 | 0.4569 | **> 0.4569** |
| AUTHORKW R@10 | 0.8076 | **> 0.8076** |
| paired McNemar | — | in our favour |

Naming (lead's addendum 1): our arms are **cshl-CITE** (citation encoder, table
`preprint_embeddings_cshl`), **cshl-QP** (last night's 40k query-pairs run, table
`preprint_embeddings_cshl_qp`), **cshl-QP2** (this run, table `preprint_embeddings_cshl_qp2`),
**cshl-RR** (reranker, another lane). FTS / MedCPT / SPECTER2 / bge-m3 are **not ours**.

Budget: **HARD CAP $10.00 new AWS spend.**
Fences: no `api/`, no serve box, no HF. No messages to other sessions. Nothing heavy on this
laptop (README device rule). The `cshl-RR` reranker lane has its own box — its instances are
not mine and are not in my ledger.

Predecessor: `docs/prompts/LANE-QPAIRS-RUN.md`, read end to end before anything was run.

---

## Status

**PHASE 0 COMPLETE — reported below. PHASE 1 blocked on one budget decision (see 02:30Z).**

---

## Log

### 2026-08-20T02:24Z — lane start

Pulled `lane/rxiv-load` (already up to date at `e931cc4`, the rig-upgrade merge). Read
`LANE-QPAIRS-RUN.md` end to end, `scripts/eval/score.mjs`, `scripts/train/train.sh`,
`scripts/train/launch.sh`, `scripts/train/from-mine.mjs`.

Frozen benchmark confirmed on disk before scoring anything against it:
```
data/eval/cshl-eval-2k/queries.jsonl  sha256 0f18abd17ed324bb…  2,000 lines
data/eval/cshl-eval-2k/qrels.tsv      sha256 d5fb1c8ba4a4b569…  2,000 lines
manifest: MESH 1,241 · AUTHORKW 759 · gold_keys_missing 0
```

### 2026-08-20T02:26Z — PHASE 0 COMPLETE. Controls reproduce; **no fusion of our own arms
clears either target.** Reporting immediately, per the brief.

Controls first, through the same code path, before any new number was read:

| arm | MeSH R@10 | published | AUTHORKW R@10 | published |
|---|---:|---:|---:|---:|
| cshl-CITE | 0.3320 | 0.3320 | 0.6693 | 0.6693 |
| `ncbi/MedCPT` | 0.4569 | 0.4569 | 0.8076 | 0.8076 |
| Postgres FTS | 0.0806 | 0.0806 | 0.2398 | 0.2398 |

Every digit. All three dense arms reported `Index Scan CONFIRMED` — no sequential-scan
fallback. The harness is trustworthy for a new number.

The three requested fusions, plus the two already on record for comparison:

| arm | MeSH R@10 | MeSH nDCG@10 | AUTHORKW R@10 | AUTHORKW nDCG@10 | ours only? |
|---|---:|---:|---:|---:|:--:|
| RRF(cshl-QP + MedCPT + FTS) | **0.5197** | 0.3879 | **0.8300** | 0.7197 | no |
| RRF(cshl-QP + cshl-CITE + MedCPT + FTS) | 0.4988 | 0.3691 | 0.8182 | 0.6957 | no |
| **`ncbi/MedCPT` — the bar** | **0.4569** | 0.3373 | **0.8076** | 0.6885 | no |
| RRF(cshl-QP + FTS) | 0.4512 | 0.3333 | 0.7655 | 0.6540 | **yes** |
| **cshl-QP alone** | 0.4319 | 0.3190 | 0.7497 | 0.6395 | **yes** |
| RRF(cshl-QP + cshl-CITE + FTS) | 0.4230 | 0.3061 | 0.7365 | 0.6289 | **yes** |
| RRF(cshl-QP + cshl-CITE) | 0.4077 | 0.2951 | 0.7273 | 0.6116 | **yes** |

**The answer is no, and it is not close.** The best fusion of our own arms is
RRF(cshl-QP + FTS) at **0.4512 / 0.7655** — short of the bar by 0.0057 on MeSH and by 0.0421
on AUTHORKW. There is no $0 system-level win to bank tonight.

**The finding that is worth more than the null result: adding cshl-CITE makes every fusion
worse, monotonically.**

```
MeSH R@10      cshl-QP alone   0.4319
             + cshl-CITE       0.4077   (−0.0242)
             + FTS             0.4512   (+0.0193)
             + CITE + FTS      0.4230   (−0.0089 vs QP alone, −0.0282 vs QP+FTS)
             + MedCPT + FTS    0.5197
      + CITE + MedCPT + FTS    0.4988   (−0.0209)
```
Same sign, same shape on AUTHORKW. cshl-CITE is not a complementary arm to cshl-QP on the
query→doc task — it is a weaker arm ranking the same documents, and RRF has no way to know
that, so it dilutes. This has a direct consequence for the ship lane: **the production fusion
should not carry cshl-CITE.** It also means the previously-published best,
RRF(ours + MedCPT + FTS) = 0.4722, is strictly dominated by RRF(cshl-QP + MedCPT + FTS)
= 0.5197 — the CITE arm should be swapped out, not added to.

Cost of Phase 0: **$0.00.** All vectors already existed; Neon queries only.

### 2026-08-20T02:30Z — BUDGET CONFLICT: the specified run does not fit the $10.00 cap

Priced from the AWS pricing API, not from memory (us-east-1, Linux, on-demand, shared):

```
g6e.12xlarge  $10.4926/hr   ($0.1749/min)   4 x L40S 48GB
g5.12xlarge   $ 5.6720/hr   ($0.0945/min)   4 x A10G 24GB
g5.xlarge     $ 1.0060/hr
g6e.xlarge    $ 1.8610/hr
```

**`g6e.12xlarge` costs the entire lane budget in 57 minutes.** The specified run does not fit
inside it. Model, built from last night's *measured* numbers rather than an estimate:

- Last night, 1 x L40S, `BATCH=8 GROUP_SIZE=8 PASSAGE_MAX_LEN=384`: **1.52 it/s = 0.658 s/step**,
  measured on the box.
- `NPROC=4` does the same per-device work per step, plus a gradient all-reduce of 568M params
  (~1.1 GB bf16) over PCIe — L40S has no NVLink. Budget **0.75–0.85 s/step**.
- 100,000 pairs / (8 x 4) = **3,125 steps** -> **39–44 min** of training.
- Box overhead, from last night's timeline (launch 23:21Z -> first training line 23:27Z) plus
  the larger slice (601 MB -> ~1.5 GB) and 100k rows to tokenize/cache: **10–13 min**.
- Post: pooling config, query embed, 2.3 GB weight upload: **~5 min**.

| plan | slice | steps | box minutes | train box $ | + re-embed N=4 | + S3 | **total** |
|---|---:|---:|---:|---:|---:|---:|---:|
| **as specified** | 100k | 3,125 | 54–62 | 9.45–10.84 | 0.70 | 0.15 | **10.30–11.69** ✗ |
| **80k slice** | 80k | 2,500 | 47–53 | 8.22–9.27 | 0.70 | 0.15 | **9.07–10.12** ~ |
| **70k slice** | 70k | 2,188 | 43–49 | 7.52–8.57 | 0.70 | 0.15 | **8.37–9.42** ✓ |

`g5.12xlarge` is **not** the cheaper fallback it looks like, and this is the trap worth naming:
last night's `BATCH=8` at `PASSAGE_MAX_LEN=384` used **33.9 GB** of the L40S's 48 GB. An A10G
has **24 GB**. `train.sh`'s OOM guard would halve to `BATCH=4`, doubling the step count to
6,250 and cutting in-batch negatives from 31 to 15. Measured A10G step time at batch 4 is
0.82 s (`train.sh` header), so: ~85 min of training + ~12 min overhead + ~4 min burnt proving
batch 8 does not fit = **~101 min = $9.55** — over budget, *slower in wall-clock*, and a
**scientifically weaker run**. It stays in `TYPE_MENU` strictly as a capacity fallback, and if
it is what we get, the slice has to shrink again.

Also rejecting `PASSAGE_MAX_LEN=256` to fit a bigger batch, for the reason last night's lane
rejected it: the embed rig indexes the full 4,000-char document, so training on half of what
is served is a train/serve mismatch — a worse defect than a smaller batch and a much quieter one.

**Watchdog.** The brief says 150 min. At $10.4926/hr that is a **$26.23** hang — 2.6x the
entire cap, and the exact anti-pattern last night's lane called out at a smaller scale. Setting
`WATCHDOG_MIN=55`, which hard-caps the box at **$9.62**. With `SAVE_STEPS` checkpointing to S3
and a run-verified resume, a watchdog kill is recoverable rather than total — but under a hard
cap it is not something to leave to a 150-minute rope.

*Decision requested — this is the lead's money and the lead's spec, and they conflict.*

### 2026-08-20T02:45Z — cap raised to $12.50 by Brendan; running the full 100k as specified

Asked, because a hard cap and a spec that does not fit inside it is the lead's call and not
mine. Answer: **keep the 100k slice, raise the cap to $12.50.** Proceeding as specified.

### 2026-08-20T02:50Z — ROCK TURNED OVER: `--negatives_cross_device` EXISTS and is wired

The brief asked me to verify the flag in the **installed** CLI rather than reason about it.
The install happens on the box, so the authoritative artifact is the previous run's own
uploaded box log — `train.sh` §1 runs `--help` and tees it, and that goes into
`/var/log/train.log`, which is uploaded. Pulled it:

```
$ aws s3 cp s3://cshl-embed-rxiv/logs/cshl-train-20260819-192100-train.log - | grep -n negatives_cross
843:  --negatives_cross_device [NEGATIVES_CROSS_DEVICE], --negatives-cross-device …
844:                        share negatives across devices (default: False)
973: negatives_cross_device=False,      <- the echoed TrainingArguments of the real run
Successfully installed FlagEmbedding-1.4.0 …
```

**It is a real argument on the installed FlagEmbedding 1.4.0, and it is off unless asked for.**
Line 973 is the load-bearing one: it is not just in `--help`, it was in the actual
`TrainingArguments` of a run that completed — so it parses.

Why it matters, in one line: under `torchrun` each rank computes its contrastive loss over
**its own** per-device batch. 4 GPUs x batch 8 without this flag gives **7** in-batch negatives
per example — *exactly what one GPU at batch 8 gives*. The extra GPUs would have bought
throughput and not one bit of extra contrastive signal.

Wired as `CROSS_DEVICE_NEGATIVES`, in `scripts/train/train.sh` (+ passthrough in `launch.sh`):
- **defaults ON whenever `NPROC>1`**, off at `NPROC=1` where it is meaningless;
- gated at runtime on `grep -- '--negatives_cross_device' /opt/flagembed-help.txt`, THIS box's
  own installed `--help`, exactly like the existing `--resume_from_checkpoint` gate. A flag
  verified against yesterday's log is a claim with a timestamp, and `pip install -U` can move
  under us between launches. If it is absent, the run says so loudly and proceeds **without**
  it rather than passing an argument `HfArgumentParser` would reject — which the OOM loop
  would misread as a non-OOM failure and abort the whole run on;
- the per-attempt log line now prints `in_batch_negatives=` and `cross_device_negatives=on|off`,
  so the run cannot later be described as something it was not.

Dry-run of the exact resolved command (no AWS, no GPU, $0):
```
[train.sh][DRYRUN] N_PAIRS=100000 NPROC=4 per_device_batch=8 effective_batch=32
                   steps_per_epoch=3125 warmup_steps=312
[train.sh][DRYRUN] cross-device negatives ON -> in-batch negatives 31 (vs 7 per-rank without it)
  … --normalize_embeddings True --negatives_cross_device True
```

### 2026-08-20T02:58Z — FAMILY_TAKE added, slice converted, spec VERIFIED in the emitted set

`from-mine.mjs` only did proportional stratification, which for this input is EXTRACT 61% /
MESH 24% / AUTHORKW 15% — i.e. it spends most of the training budget on the one family the
benchmark contains none of. Added `FAMILY_TAKE`, with a deliberately unforgiving contract:
every named family must exist and have enough rows; unnamed families are dropped entirely;
and the per-family counts are **re-counted from the emitted set** and asserted against the
spec, so `families_emitted matches the spec` is a check and not a claim. Same deterministic
md5 ordering as `SUBSAMPLE`, so a take of N is a prefix of a take of N+1. Every existing guard
kept — abort-on-zero, computed disjointness, the emitted-vs-convertible distinction.

```
read 424,753 · convertible 424,753 · dropped 0 · rejected for touching the frozen benchmark 0
  MESH:     102,667 -> 55,000
  AUTHORKW:  62,166 -> 40,000
  EXTRACT:  259,920 ->  5,000
EMITTED families: {"MESH":55000,"AUTHORKW":40000,"EXTRACT":5000}
EMITTED disjointness: 0 references to frozen-benchmark gold papers (must be 0)
EMITTED query-string overlap with benchmark: 835 / 100,000 (disclosed, not a leak)
FAMILY_TAKE VERIFIED: families_emitted matches the spec exactly (100,000 pairs)
wrote 100,000 pairs -> data/train/qpairs2/train.jsonl   (1,561,115,915 bytes)
```

**AUTHORKW supervision goes from 5,854 pairs to 40,000 — a 6.8x increase.** That is the single
biggest deliberate change in this run, and it is aimed squarely at the family where we lose to
MedCPT by the widest margin (0.7497 vs 0.8076).

Independent verification of the file, re-read from disk rather than taken from the converter:
```
lines 100,000 · malformed 0
query chars:    min 8 · avg 77 · max 352        <- query-shaped; shorter than last night's
                                                   avg 110 because AUTHORKW is now the bulk
positive chars: avg 1,759 · max 4,000
negatives/row:  8 x 83,681 · 7 x 15,075 · 6 x 1,183 · 5 x 59 · 4 x 2
```
Uploaded byte-exact: S3 `1561115915` = local `1561115915`. `EVAL_VERSION=cshl-eval-2k`, so the
box embeds **the actual frozen 2,000 benchmark queries** rather than v1's 10,000 — which
sidesteps the qid-namespace trap from last night entirely instead of guarding against it.
Re-confirmed the `write-eval-artifacts` inline policy is still on the role and still grants
`s3:PutObject` on `eval/*`; `launch.sh` only re-puts `read-dburl`, so it cannot clobber it.

### 2026-08-20T03:12–03:18Z — g6e.12xlarge has ZERO capacity region-wide. Landed on g5.12xlarge.

Six launch attempts over six minutes. All free — a capacity refusal costs nothing and leaves
no orphan (verified with `describe-instances`, not the script's word for it).

```
03:12Z  g6e.12xlarge  no capacity in 4/4 AZs · g5.12xlarge no capacity in 5/5 AZs
03:13Z  g6e.12xlarge  no capacity in 4/4 AZs
03:14Z  g6e.12xlarge  no capacity in 4/4 AZs
03:15Z  g6e.12xlarge  no capacity in 4/4 AZs
03:17Z  g6e.12xlarge  no capacity in 4/4 AZs
03:18Z  g6e.12xlarge  no capacity · g5.12xlarge -> LAUNCHED i-0b7c04759e791d6dd (us-east-1d)
```

The menu could not be widened further, and that is a quota fact rather than a preference:
```
Running On-Demand G and VT instances: 64 vCPU
  g6e.12xlarge 48 vCPU · 4x L40S 48GB      <- wanted, unavailable
  g5.12xlarge  48 vCPU · 4x A10G 24GB      <- got this
  g6.12xlarge  48 vCPU · 4x L4   24GB      <- in the menu, not reached
  g6e.24xlarge 96 vCPU                     <- OVER QUOTA, cannot be tried
  g4dn.12xlarge 48 vCPU · 4x T4            <- excluded: Turing has no bf16, and --bf16 is set
```

**`BATCH=4` was pre-set for the fallback types rather than left to the OOM guard.** Last
night measured `BATCH=8` at `PASSAGE_MAX_LEN=384` using **33.9 GB**; an A10G has 22.9 GB, so
batch 8 cannot fit and the guard would have spent ~4 minutes of a $5.672/hr box proving it.
This is the one place tonight where a known measurement was worth more than letting a
self-correcting loop rediscover it.

**What this costs the experiment, stated now rather than in the report.** Effective batch is
**16, not 32**, so cross-device negatives give **15** in-batch negatives rather than 31. The
"4x the contrastive signal" claim becomes 2x. The step count doubles to **6,250**, because the
per-device batch halved. Two of the run's levers survive intact — 100k pairs and the
benchmark-weighted family mix — and the third is half-pulled.

**The `WATCHDOG_MIN=70` set for the L40S plan is now too short and must be re-set from
measurement, not from this estimate.** 6,250 steps at the A10G's measured 0.82 s/step is ~85
min of training before DDP overhead. Extending it blindly would be the same mistake in the
other direction, so the watchdog moves once the box reports a real it/s.

### 2026-08-20T03:25Z — THE MULTI-GPU RUN DIED ON ITS OWN ARITHMETIC. Killed at 9.5 min.

The OOM marker fired and it is surfaced here the moment it fired, not discovered in the report.
**`BATCH=4` did not hold on the A10G either.** The guard halved again:

```
[rank3]: torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 48.00 MiB.
         GPU 3 has a total capacity of 22.06 GiB of which 35.38 MiB is free.
[train.sh] OOM — halving batch to 2
[train.sh] attempt: nproc=4 per_device_batch=2 effective_batch=8 in_batch_negatives=7
           warmup_steps=1250 gradient_checkpointing=off save_steps=400 cross_device_negatives=on
  1%|  | 119/12500 [03:06<5:21:00, 1.56s/it]
```

Read that attempt line carefully, because it is the whole disaster in one row:

1. **`in_batch_negatives=7`.** The cross-device flag is ON and working — and it is gathering
   across four ranks of batch 2, so the effective batch is **8**. That is *exactly* the 7
   in-batch negatives last night's single-GPU run got. **The rock I turned over was
   neutralised by the hardware I could actually get.** The flag is not at fault and it stays
   wired; there was simply nothing left to gather.
2. **`1.56 s/it` over `12,500` steps = 5 hours 22 minutes.** At $5.672/hr that is **$30.45** —
   2.4x the raised cap — and the 70-minute watchdog would have killed it at step ~2,700 of
   12,500 regardless, leaving a 22%-trained model and a $6.60 bill.

**Why it was so slow, since "A10G is slower than L40S" does not begin to cover it.** Last
night: 1x L40S, 64 passages per step, **0.658 s/step**. Tonight: 4x A10G, 16 passages *per
device* per step — **four times less work per device** — at **1.56 s/step**, 2.4x slower. The
A10G/L40S ratio is ~1.8x; this is ~10x worse than that per unit of work. The fixed cost that
does not shrink with the batch is the DDP gradient all-reduce: 568M parameters every single
step, on a `g5.12xlarge`, which has **no NVLink**. Halving the per-device batch twice made the
compute:communication ratio catastrophic — each halving bought memory headroom and paid for it
by doubling the number of times that fixed 568M-parameter sync has to happen.

**This is the honest generalisation, and it is worth more than tonight's run:** data-parallel
multi-GPU only pays when the per-device batch stays large. The moment an OOM guard halves the
per-device batch to fit a smaller card, a 4-GPU box becomes *slower* than one big card **and**
loses the contrastive-signal benefit that was the entire reason to want four of them. The rig's
OOM guard and its multi-GPU support interact badly, and nothing in either one knows it.

**Terminated `i-0b7c04759e791d6dd` at 03:28:27Z** — explicitly, not left to the watchdog.
Lifetime 03:18:55 -> 03:28:27 = **9.5 min = $0.90**. Itemised as waste below.

### 2026-08-20T03:28Z — RELAUNCHED on the proven single L40S. First try, no capacity fight.

```
i-0efe2e00b91aedceb   g6e.2xlarge   us-east-1 (subnet-09e840612db030382)   03:28:38Z
run_id 20260819-232838-train
NPROC=1 BATCH=8 GROUP_SIZE=8 QUERY_MAX_LEN=128 PASSAGE_MAX_LEN=384 EPOCHS=1
SAVE_STEPS=400 WATCHDOG_MIN=175 EVAL_VERSION=cshl-eval-2k
```

Chosen on the measurement rather than on preference. Every alternative was priced first:

| option | in-batch negs | wall-clock | $ | verdict |
|---|---:|---:|---:|---|
| **1x L40S, batch 8** (this) | 7 | ~155 min | **5.79** | proven config, proven throughput, fits |
| 4x A10G, batch 2 | 7 | ~322 min | 30.45 | what just died |
| 4x A10G + `gradient_checkpointing`, batch 8 | 31 | ~180 min est | 17.0 | over cap, and the estimate is speculative |
| 1x L40S on `g6e.4xlarge` | 7 | ~155 min | 7.75 | same single L40S, +34% for nothing |
| 4x L4 `g6.12xlarge` | 15 | ~200 min est | 15.3 | over cap; also never reached capacity |

12,500 steps at last night's measured 0.658 s/step = **137 min of training**, plus ~7 min
setup and ~6 min for the weight upload and query embed. `WATCHDOG_MIN=175` caps the worst case
at **$6.54** and leaves ~25 min of headroom over the expectation — sized to the run instead of
inherited, in both directions.

**What survives and what does not, stated before the result.** Surviving: the 100k slice (2.5x
last night's data) and the benchmark-weighted family mix (**AUTHORKW 5,854 -> 40,000**). Not
surviving: the larger effective batch and the 31 in-batch negatives — this run gets the same
batch 8 and the same 7 in-batch negatives as last night. So tonight is a **clean single-lever
experiment after all**: same hardware, same batch, same objective, same everything except *how
much data and in what mix*. That is a better-controlled comparison than the run I set out to
make, and it is the one thing the capacity failure gave back.

`--negatives_cross_device` stays wired, verified, and defaulted-on for `NPROC>1`. It is off
here because `NPROC=1`, and `train.sh` says so in its own log rather than leaving it ambiguous.

### 2026-08-20T03:33Z — PRE-STAGED command lines (lead addendum 2: fire within 60s of each phase)

Every command below is written out now, against `run_id 20260819-232838-train`, so no phase
waits on me composing a command. Polling is on the **S3 weight prefix directly** rather than on
noticing the box disappear.

**P0 — the completion signal (poll this, not the instance state):**
```sh
aws s3 ls s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-232838-train/final/
# done when model.safetensors is ~2,271,064,456 bytes AND 1_Pooling/ and modules.json exist
aws s3 ls s3://cshl-embed-rxiv/eval/cshl-eval-2k/qemb-20260819-232838-train.jsonl
```

**P1 — slim the weights before four boxes download them ($0, saves ~$0.06 and minutes):**
`final/` will carry up to 3 `checkpoint-*/` dirs at ~6.8 GB each (2.3 GB model + 4.5 GB
optimizer). Four embed boxes downloading 23 GB instead of 2.3 GB is pure waste.
```sh
aws s3 cp --recursive --exclude 'checkpoint-*' \
  s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-232838-train/final/ \
  s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-232838-train/serve/
aws s3 ls --recursive --human-readable --summarize \
  s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-232838-train/serve/
```

**P2 — re-embed into the FOURTH table, N=4 (lead addendum 2: time first):**
```sh
MODEL_S3=s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-232838-train/serve \
EMB_TABLE=preprint_embeddings_cshl_qp2 EMB_MODEL=cshl-encoder-bge-m3-qpairs2 \
DIM=1024 NORMALIZE=1 CAP=4000 N=4 TYPE=g6e.xlarge \
  ./scripts/embed-nsr/launch.sh
# g6e unavailable -> TYPE=g5.xlarge AND TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:86-1.8
#   (the default `89` image is Ada-only; on Ampere it starts a container that never loads a
#    model and never complains — last night's trap, not a guess)
```
Safe to run concurrently with anything: the embed rig's `launch.sh` re-puts `read-dburl`, but
the train box's weight-upload grant lives in the separate `write-model-artifacts` policy and
the eval-write grant in `write-eval-artifacts`. Verified both are on the role tonight, by name.
That is last night's incident actually fixed rather than remembered.

**P3 — install the query vectors (the digest guard is the point):**
```sh
aws s3 cp s3://cshl-embed-rxiv/eval/cshl-eval-2k/qemb-20260819-232838-train.jsonl /tmp/qp2.jsonl
SRC=/tmp/qp2.jsonl ARM=cshl_qp2 VERSION=cshl-eval-2k EXPECT_DIM=1024 \
  node scripts/eval/qemb-from-run.mjs
```
`EVAL_VERSION=cshl-eval-2k` was set at launch, so the box embeds **the 2,000 benchmark queries
themselves**. Last night's qid-namespace trap (943/2,000 of the 2k's qids collide with
different queries in v1) cannot fire here — there is no v1 in the path at all.

**P4 — index, after the sweep, never before (`indexes.sql`'s own rule):**
```sql
CREATE INDEX IF NOT EXISTS idx_pp_emb_cshl_qp2_hnsw
  ON preprint_embeddings_cshl_qp2 USING hnsw (embedding vector_cosine_ops);
```
Watched through `pg_stat_progress_create_index`, not by waiting on the session — last night a
single-query readiness check reported `HNSW-INDEX-READY` at 73% built.

**P5 — coverage gate, re-derived at assertion time:**
```sh
ARMS=cshl_qp2 EXPECT_CORPUS=433449 node scripts/eval/coverage-gate.mjs
```

**P6 — score. Controls FIRST, in the same invocation, so the harness reproduces the old digits
before it is trusted with a new one:**
```sh
EVAL_VERSION=cshl-eval-2k ARMS="cshl,medcpt,fts,cshl_qp,cshl_qp2,\
rrf:cshl_qp2+fts,rrf:cshl_qp2+cshl_qp,rrf:cshl_qp2+cshl_qp+fts,\
rrf:cshl_qp2+medcpt+fts,rrf:cshl_qp2+cshl_qp+medcpt+fts" node scripts/eval/score.mjs
```

**P7 — the verdict, per family, paired:**
```sh
for F in MESH AUTHORKW; do
  FAMILY=$F A=cshl_qp2 B=medcpt  DIR=data/eval/cshl-eval-2k/results node scripts/eval/paired-test.mjs
  FAMILY=$F A=cshl_qp2 B=cshl_qp DIR=data/eval/cshl-eval-2k/results node scripts/eval/paired-test.mjs
done
```
`FAMILY=` is new tonight — `paired-test.mjs` could only do the blended comparison, and a
blended win can hide a per-family loss when the two families differ this much in difficulty.
**Verified against known digits before being trusted**: sliced per-family, it reproduces last
night's published `cshl-QP vs MedCPT` rows exactly — MESH ΔR@10 −0.0250, p=0.0713,
CI [−0.0516, +0.0016]; AUTHORKW ΔR@10 −0.0580, p=0.0003, CI [−0.0883, −0.0277].

**P8 — doc→doc regression check:**
```sh
ARMS=bge-m3,medcpt,cshl,cshl_qp,cshl_qp2 node scripts/eval/score-docdoc.mjs
A=cshl_qp2 B=cshl DIR=data/eval/cshl-eval-docdoc/results node scripts/eval/paired-test.mjs
```

### 2026-08-20T03:33Z — ANCE hard-negative miner DRAFTED and SMOKE-TESTED (lead addendum 2)

`scripts/train/mine-ance.mjs`. **Not fired, and it cannot be fired by accident**: it refuses to
write anywhere under `data/train/` without `ALLOW_TRAIN_WRITE=1`, so nothing a launcher would
pick up can appear without an explicit act. A full mine and any retrain on it are Brendan's
call only.

The design decision worth reviewing before it is ever run is **`SKIP_TOP` (default 5)**. Naive
ANCE takes the model's top-ranked non-golds as negatives, and in a 433,449-paper corpus where
each query has ~1 labelled gold, the model's most confident non-golds are disproportionately
*unlabelled positives*. Training on those teaches the model that a correct answer is wrong —
the standard reason naive ANCE rounds regress. `SKIP_TOP` discards them; `SKIP_TOP=0`
reproduces naive ANCE so the difference can be measured rather than argued.

Smoke test — 200 queries, read-only, no GPU, **$0**, against the existing `cshl-QP` vectors:
```
frozen benchmark gold papers (hard gate): 1,839
joined on qid: 2,000 of 2,000 vectors (0 unmatched)   <- the qid trap would show here
retrieved 200 x top-100
  struck: 160 own-gold · 9 frozen-benchmark gold · 846 discarded as likely-unlabelled
  kept 200 queries with >= 4 negatives · dropped 0 · negatives/row: {"8":200}
  where the labelled gold landed: {top1:117, top2:14, top3:5, top4:9, top5:5, …, 11-50:14, 51-100:7}
  emitted negatives referencing frozen-benchmark gold papers: 0 (must be 0)
```
Every gate fired on real data: own-gold struck, **9 cross-query frozen-benchmark golds struck**
(the gate that stops the benchmark leaking into training via another query's retrieval), and
the emitted set independently re-checked rather than the per-row decisions being trusted.

That gold-rank histogram is also a free measurement of the current model: **117/200 queries put
the labelled gold at rank 1**, and 21/200 have it below rank 10 — which is what the 0.4319 MeSH
R@10 looks like from the inside.
