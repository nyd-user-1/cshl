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

**COMPLETE — 2026-08-20T06:49Z. See "THE VERDICT".**

**MeSH R@10 0.4319 -> 0.5238. We beat `ncbi/MedCPT` on MeSH (0.4569) by +0.0669, p=1.01e-6,
CI [+0.0403, +0.0927] — target MET.** AUTHORKW 0.7497 -> 0.7642 against a 0.8076 bar: still a
significant loss alone (p=0.0046), statistical parity when fused with FTS (0.7800, p=0.0709) —
target **NOT** met. Spend $7.57 of a $12.50 cap. No GPU running at close.

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

### 2026-08-20T03:34Z — training is genuinely healthy, at the batch we asked for, on the
throughput we predicted

```
[train.sh] 100000 training pairs in qpairs2
[train.sh] manifest disjointness: {"pass": true, ... "emitted_references_to_gold_papers": 0}
[train.sh] attempt: nproc=1 per_device_batch=8 effective_batch=8 in_batch_negatives=7
           warmup_steps=1250 gradient_checkpointing=off save_steps=400 cross_device_negatives=off
  12%|█▏ | 1490/12500 [16:54<2:02:34, 1.50it/s]
NVIDIA L40S · 34,099 MiB / 46,068 MiB · GPU utilization 100%
```

**1.50–1.53 it/s against last night's measured 1.52, and 34,099 MiB against last night's
33,883 MiB.** The estimate this run was priced on reproduced on the hardware, which is the only
reason the cost projection below can be trusted. No OOM: batch 8 held on the first attempt, so
nothing was burnt rediscovering it.

Checkpointing verified *working*, not merely configured — `SAVE_STEPS=400` with the background
syncer, three checkpoints already in S3 and `save_total_limit=3` correctly pruning the local
disk (38% used of 146 GB):
```
s3://…/models/cshl-encoder-bge-m3/20260819-232838-train/checkpoints/
  PRE checkpoint-400/  PRE checkpoint-800/  PRE checkpoint-1200/
```

Training ends ~**05:52Z**; the box should self-terminate ~05:58Z after the pooling config, the
2,000-query embed and the 2.3 GB weight upload. Watchdog fires **06:24:31Z** — ~26 min of real
headroom, sized to this run rather than inherited.

Two independent watches are armed, because a log that stops printing and a job that stopped
working look identical from one of them: a 7-minute SSM poll of the box's own progress line
*plus its failure markers* (`Traceback|OutOfMemory|OOM — halving|CUDA error`, so silence cannot
be mistaken for health), and a separate watcher on the **S3 weight prefix**, which fires the
moment `final/model.safetensors` appears rather than when I notice the box is gone.

### Spend ledger — running, from measured instance lifetimes

| when | item | rate | minutes | $ |
|---|---|---|---:|---:|
| 02:26Z | PHASE 0: 7 arms scored on the frozen 2k | — | — | **0.00** |
| 02:50Z | pricing/quota/IAM API reads, 11 capacity-refused launches | — | — | **0.00** |
| 03:33Z | ANCE miner smoke test, 200 queries, read-only | — | — | **0.00** |
| 03:18–03:28Z | train `i-0b7c04759e791d6dd` g5.12xlarge — **killed, see 03:25Z** | $5.672/hr | 9.5 | **0.90** |
| 03:28–~05:58Z | train `i-0efe2e00b91aedceb` g6e.2xlarge (projected) | $2.24208/hr | ~150 | **~5.60** |
| — | re-embed N=4 (projected) | — | — | ~0.70 |
| — | S3 (1.5 GB slice, 2.3 GB weights x2 prefixes, checkpoint syncs) | — | — | ~0.20 |
| | **PROJECTED TOTAL** | | | **~7.40** |

Against the raised **$12.50** cap. The 11 refused launches cost nothing and left no orphans
(checked with `describe-instances`, not the launcher's word for it).

**Waste, itemised — mine, not folded into the total**

| item | $ | what happened |
|---|---:|---|
| the 4-GPU attempt | **0.90** | 9.5 min of a g5.12xlarge to learn that halving the per-device batch to fit a 24 GB card destroys the compute:communication ratio AND the in-batch negative count that was the only reason to want four GPUs. Bought a real generalisation (see 03:25Z), but it was still $0.90 I did not have to spend if I had priced the A10G's memory before adding it to the menu. |

### 2026-08-20T04:09Z — free confound ruled out: `hnsw.ef_search=100` is NOT what separates us
from MedCPT

Every number in this program is measured at `hnsw.ef_search=100`, which is an *approximate*
search. Before attributing any part of the gap to the encoders, it is worth knowing how much of
it is the index. Rather than re-score everything at a higher `ef` (slow, and it would break
comparability with every published digit), measured the approximation directly:
`scripts/eval/ann-recall.mjs` takes 150 benchmark queries and compares the top-10 the scorer
actually sees at `ef=100` against the top-10 at `ef=1000`, **for our arm and MedCPT both** —
a check applied to one arm cannot say anything about a gap between two.

```
cshl_qp  n=150  top-10 identical 127/150  mean overlap 96.9%  rank-1 identical 145/150
medcpt   n=150  top-10 identical 112/150  mean overlap 96.9%  rank-1 identical 148/150
```

**96.9% and 96.9%.** The ANN approximation costs about 3% of top-10 slots and it costs both
arms the same to three significant figures. It is not a hidden handicap on our side, raising
`ef` is not a free win worth invalidating the published numbers for, and the 0.4319-vs-0.4569
gap is an encoder difference rather than an index artifact. $0.00, and one fewer thing the
result can be argued away with.

### 2026-08-20T05:57Z — TRAINING COMPLETE, clean, and this time the query upload worked

```
{'train_runtime': 8554.83, 'train_samples_per_second': 11.689, 'train_steps_per_second': 1.461,
 'train_loss': 0.21003, 'epoch': 1.0}
[train.sh] wall-clock: 8620s EXIT=0 final_batch=8 final_effective_batch=8
           gradient_checkpointing=off cross_device_negatives=off
[train.sh] final checkpoint sync done
[train.sh] wrote SBERT pooling config (CLS)
[train.sh] embedded 2000 eval queries, dim 1024
[train.sh] done. weights: s3://…/models/cshl-encoder-bge-m3/20260819-232838-train/final/
```

**12,500 steps at batch 8, one epoch over 100,000 pairs, EXIT=0, no OOM at any point.**
`final_batch=8` is the batch we asked for — unlike last night, nothing was silently halved.
`cross_device_negatives=off` is correct and deliberate at `NPROC=1`, and the script says so
itself rather than leaving it to be inferred.

**`AccessDenied` count in the entire box log: 0.** Last night's incident — `train.sh` §5b's
query-vector upload denied and swallowed by `|| true`, discovered only after the box was gone
— did not recur. The `write-eval-artifacts` inline policy held, because `launch.sh` only
re-puts `read-dburl` by name and cannot clobber a policy it does not know about. That is a
fix that was verified by being exercised, not by being remembered.

**`embedded 2000 eval queries`, not 10,000.** `EVAL_VERSION=cshl-eval-2k` meant the box
embedded the frozen benchmark's own 2,000 queries directly. Last night's qid-namespace trap
(943 of the 2k's qids name *different queries* in v1) had nothing to bite on.

Weights complete and byte-checked: `model.safetensors` **2,271,064,456 bytes**, identical in
size to last night's — same 568M-parameter architecture, as it must be. Plus `1_Pooling/`,
`modules.json` and `sentence_bert_config.json`, the CLS-pooling config whose absence would
silently give mean pooling.

Box `i-0efe2e00b91aedceb` self-terminated **06:00:38Z**. Lifetime 03:28:38 → 06:00:38 =
**152 min = $5.68**, against the $5.60 projected at 03:34Z from the measured it/s. The watchdog
at 06:24:31Z was never approached.

### 2026-08-20T05:58Z — P1/P3 fired within 60s of the weights landing (lead addendum 2)

**P1 — weights slimmed before four boxes could download them.** `final/` was **21.2 GiB**
(three retained `checkpoint-*` dirs carrying 4.5 GB optimizer states each). `serve/` is
**2.1 GiB, 10 objects**. Four boxes x 19 GiB not downloaded.

**P3 — query vectors installed, and the guard that matters passed:**
```
2,000 rows -> 2,000 matched this benchmark   (zero missing: the qid trap did not fire)
dim 1024 · norms [1.0000, 1.0000] · non-finite 0 · all-zero 0
  distinct from qemb/bge-m3.jsonl   (b86fe21a81f6… vs 7eadd4928ce2…) OK
  distinct from qemb/cshl.jsonl     (9be967585172… vs 7eadd4928ce2…) OK
  distinct from qemb/cshl_qp.jsonl  (30c8a3e6490c… vs 7eadd4928ce2…) OK
  distinct from qemb/medcpt.jsonl   (18ed37ddaffc… vs 7eadd4928ce2…) OK
  distinct from qemb/specter2.jsonl (2e8911a7ccbb… vs 7eadd4928ce2…) OK
md5 7eadd4928ce22fbc2c4ae27c8e761ca5
```
**`distinct from qemb/cshl_qp.jsonl` is the load-bearing line tonight.** cshl-QP and cshl-QP2
are two fine-tunes of the same base model, on overlapping data, scored on the same queries —
the two arms in this whole program most able to collide into "two arms, one model." They did
not.

### 2026-08-20T06:02Z — P2 fired: re-embed into the FOURTH table, N=4

```
box 0: i-00d51fd0f63ce6242   g6e.xlarge   subnet-0407bd1ff7e9d8c44
box 1: i-02af1bf6e2a3cb916   g6e.xlarge   subnet-09e840612db030382  (3 AZs refused first)
box 2: i-0b8320cd013cbb9db   g6e.xlarge   subnet-09e840612db030382  (3 AZs refused first)
box 3: i-088e3a8e277a4b698   g6e.xlarge   subnet-09e840612db030382  (2 AZs refused first)
EMB_TABLE=preprint_embeddings_cshl_qp2  DIM=1024  NORMALIZE=1  CAP=4000  PARTS=4
```

All four are `g6e.xlarge` (L40S), so the default Ada TEI image `89-1.8` is the correct one and
no `TEI_IMAGE` override was needed. `preprint_embeddings_cshl_qp` is **not** touched — it may
be serving production tonight.

Query and document vectors now match in **both recipe and precision** on this arm: the corpus
side goes through TEI at fp16 with `NORMALIZE=1`, and… the query side came from
sentence-transformers at fp32 on the train box. Disclosed rather than glossed: that is the same
mismatch the incumbent `cshl` arm has, and the opposite of `cshl_qp`, whose query vectors were
recovered through TEI. It favours no one, but it is a difference between two arms' measurement
and it should be on the record before the numbers are.

---

# THE VERDICT

**MeSH: WON, decisively. AUTHORKW: NOT WON — a significant loss alone, statistical parity when
fused with FTS. One of the two targets is met.**

Scored on the frozen 2,000-query subsample `cshl-eval-2k` (MESH 1,241 · AUTHORKW 759,
`sha256 0f18abd1…`), full-corpus retrieval against 433,449 papers, `hnsw.ef_search=100`, cosine
for our arms, inner product over raw `[CLS]` for MedCPT.

## Against the two targets, stated flatly

| target | bar (MedCPT) | cshl-QP2 alone | RRF(cshl-QP2 + FTS) — **ours only** | verdict |
|---|---:|---:|---:|:--|
| **MeSH R@10** | 0.4569 | **0.5238** | **0.5326** | **WIN** |
| **AUTHORKW R@10** | 0.8076 | 0.7642 | 0.7800 | **LOSS / parity** |

## Query→document, the task the product serves

| arm | MeSH R@10 | MeSH nDCG@10 | AUTHORKW R@10 | AUTHORKW nDCG@10 | ours only? |
|---|---:|---:|---:|---:|:--:|
| RRF(cshl-QP2 + MedCPT + FTS) | **0.5552** | **0.4173** | **0.8458** | **0.7270** | no |
| **RRF(cshl-QP2 + FTS)** | **0.5326** | 0.3938 | **0.7800** | 0.6678 | **yes** |
| RRF(cshl-QP2 + cshl-QP + MedCPT + FTS) | 0.5342 | 0.4033 | 0.8155 | 0.7151 | no |
| **cshl-QP2 alone** | **0.5238** | 0.3881 | **0.7642** | 0.6502 | **yes** |
| RRF(cshl-QP2 + cshl-QP + FTS) | 0.4915 | 0.3673 | 0.7694 | 0.6624 | yes |
| RRF(cshl-QP2 + cshl-QP) | 0.4811 | 0.3608 | 0.7484 | 0.6417 | yes |
| **`ncbi/MedCPT` — the bar** | **0.4569** | 0.3373 | **0.8076** | 0.6885 | no |
| cshl-QP (last night) | 0.4319 | 0.3190 | 0.7497 | 0.6395 | yes |
| cshl-CITE | 0.3320 | 0.2367 | 0.6693 | 0.5625 | yes |
| Postgres FTS | 0.0806 | 0.0626 | 0.2398 | 0.2286 | yes |

R@1: cshl-QP2 **0.2691** (MeSH) / **0.5349** (AUTHORKW), against MedCPT's 0.2345 / 0.5731.

**On MeSH we beat a purpose-built biomedical retriever, alone, without fusing anything.**
0.4319 → **0.5238**, +21.3% relative in one night, and 0.0669 *above* MedCPT rather than 0.0250
below it. The gap did not close; it reversed.

## The significance tests — paired, per family, same queries in the same order (asserted)

**cshl-QP2 vs `ncbi/MedCPT`:**

| family | n | QP2-only | MedCPT-only | ΔR@10 | exact p | bootstrap 95% CI | |
|---|---:|---:|---:|---:|---:|---|:--|
| **MESH** | 1,241 | 184 | 101 | **+0.0669** | **1.01e-6** | **[+0.0403, +0.0927]** | **WIN** |
| AUTHORKW | 759 | 48 | 81 | **−0.0435** | **0.0046** | **[−0.0738, −0.0145]** | **LOSS** |

On MeSH the confidence interval sits **entirely above zero**. On author keywords it sits
**entirely below zero**. Neither is a coin-flip and neither needs a careful reading to survive.

**RRF(cshl-QP2 + FTS) — our own arms only — vs `ncbi/MedCPT`:**

| family | n | ours-only | MedCPT-only | ΔR@10 | exact p | bootstrap 95% CI | |
|---|---:|---:|---:|---:|---:|---|:--|
| MESH | 1,241 | 185 | 91 | **+0.0757** | **1.59e-8** | [+0.0500, +0.1015] | **WIN** |
| AUTHORKW | 759 | 51 | 72 | −0.0277 | **0.0709** | **[−0.0567, +0.0013]** | **parity** |

Adding FTS lifts author keywords from a significant loss (p=0.0046) to **statistical parity**
(p=0.0709, CI crossing zero) — we can no longer distinguish the fusion from MedCPT there. It is
still **not** a win, and 0.7800 does not clear 0.8076.

**cshl-QP2 vs cshl-QP — what tonight's changes actually bought:**

| family | n | QP2-only | QP-only | ΔR@10 | exact p | bootstrap 95% CI |
|---|---:|---:|---:|---:|---:|---|
| MESH | 1,241 | 157 | 43 | **+0.0919** | **1.90e-16** | [+0.0701, +0.1136] |
| AUTHORKW | 759 | 42 | 31 | +0.0145 | **0.2416** | **[−0.0066, +0.0356]** |

## The finding I did not expect, and it is the important one

**The change aimed at AUTHORKW did almost nothing for AUTHORKW, and the incidental change to
MESH did almost everything.**

| family | training pairs, last night → tonight | multiplier | ΔR@10 | p |
|---|---|---:|---:|---:|
| AUTHORKW | 5,854 → **40,000** | **6.8x** | **+0.0145** | **0.24 — not significant** |
| MESH | 9,668 → **55,000** | 5.7x | **+0.0919** | 1.9e-16 |

Comparable multipliers; **six-fold different outcomes**. Nearly seven times the author-keyword
supervision produced a change I cannot distinguish from noise, while a slightly smaller
multiplier on MeSH produced the largest single jump this program has measured.

That is not what a data-quantity story predicts, and it should change what gets tried next.
The most likely reading: **author-keyword retrieval is not supervision-limited, it is
representation- or objective-limited.** Author keywords are short, idiosyncratic, author-chosen
label sets — a bi-encoder squeezing them into one 1024-d vector may simply be near its ceiling
on that family, and MedCPT's remaining edge there may come from something more data will not
buy. Every remaining lever that is *more of the same supervision* is now a poor bet on
AUTHORKW, and that includes the second epoch. See the contingency ranking below.

A second consequence, already visible at 02:26Z and confirmed again tonight: **fusing our own
encoders with each other makes things worse, monotonically.** RRF(QP2 + QP) = 0.4811 against
QP2 alone at 0.5238. cshl-QP is not a complementary view, it is a weaker view of the same
thing, and RRF cannot tell the difference. **The production fusion should carry exactly one of
our encoders — the newest — plus FTS.**

## Document→document — the trade, unchanged

| arm | R@1 | R@10 | R@50 | MRR |
|---|---:|---:|---:|---:|
| cshl-CITE | 0.0700 | **0.2120** | 0.3445 | 0.1167 |
| cshl-QP (last night) | 0.0630 | 0.1980 | 0.3145 | 0.1061 |
| **cshl-QP2** | 0.0670 | **0.1960** | 0.3115 | 0.1098 |
| stock `BAAI/bge-m3` | 0.0620 | 0.1955 | 0.2900 | 0.1053 |
| `ncbi/MedCPT` | 0.0580 | 0.1790 | 0.3020 | 0.0985 |

| comparison | ΔR@10 | exact p |
|---|---:|---:|
| QP2 vs cshl-CITE | −0.0160 | 0.0159 |
| QP2 vs cshl-QP | −0.0020 | **0.7926** |
| QP2 vs stock bge-m3 | +0.0005 | **1.0000** |
| QP2 vs MedCPT | +0.0170 | 0.0397 |

**p = 1.0000 against the base model.** On document→document, cshl-QP2 is indistinguishable from
the `BAAI/bge-m3` it was fine-tuned from — the citation training's doc→doc advantage was already
spent by last night's run and tonight neither recovered nor further damaged it (p=0.79 vs
cshl-QP). cshl-CITE remains the better doc→doc encoder and the right one for "more like this",
reviewer matching and systematic-review expansion. All four tables stay populated, so both
remain available.

## Controls — the harness produced the old numbers before it produced a new one

| arm | MeSH R@10 | published | AUTHORKW R@10 | published |
|---|---:|---:|---:|---:|
| cshl-CITE | 0.3320 | 0.3320 | 0.6693 | 0.6693 |
| `ncbi/MedCPT` | 0.4569 | 0.4569 | 0.8076 | 0.8076 |
| Postgres FTS | 0.0806 | 0.0806 | 0.2398 | 0.2398 |
| cshl-QP | 0.4319 | 0.4319 | 0.7497 | 0.7497 |

Every digit, in the same invocation that produced the new arm, **after** the registry edit — so
the edit is inside the test. doc→doc controls likewise: bge-m3 0.1955, MedCPT 0.1790, CITE
0.2120, cshl-QP 0.1980, all exact. All dense arms reported `Index Scan CONFIRMED`; none fell
back to a sequential scan.

## Coverage gate — re-derived at assertion time, nothing taken from a pass report

**PASSED 2026-08-20T06:40Z.**
```
corpus 433,449 · embeddable 433,449 · excluded by the <20-char rule 0
preprint_embeddings_cshl_qp2  433,449  uncovered 0  dim 1024  zero-vectors 0
  vectors + uncovered = corpus : 433,449 + 0 = 433,449
  norms outside [0.99, 1.01]   : 0
  model tag                    : cshl-encoder-bge-m3-qpairs2  (433,449 rows)
text_hash vs canonical recipe  : 0 mismatches of 433,449 (cap 4000)
HNSW idx_pp_emb_cshl_qp2_hnsw  3,386 MB  vector_cosine_ops  indisvalid=t indisready=t

untouched, as required — last write timestamps read at assertion time:
  preprint_embeddings          433,449   2026-08-19 07:07:28Z
  preprint_embeddings_medcpt   433,449   2026-08-19 07:07:19Z
  preprint_embeddings_cshl     433,449   2026-08-19 14:06:41Z
  preprint_embeddings_cshl_qp  433,449   2026-08-20 00:52:45Z   <- production-safe, not written
  preprint_embeddings_cshl_qp2 433,449   2026-08-20 06:08:08Z   <- tonight's
```

The query-vector file digest-differs from every other arm's, checked before it was written:
`cshl_qp2` md5 `7eadd4928ce2…` vs `cshl_qp` `30c8a3e6490c…`, `cshl` `9be967585172…`,
`bge-m3` `b86fe21a81f6…`, `medcpt` `18ed37ddaffc…`, `specter2` `2e8911a7ccbb…`.

## The index build lied about being finished, and it was caught

`CREATE INDEX` issued through the Neon **HTTP** driver returned
`UND_ERR_HEADERS_TIMEOUT` after 5 minutes. The natural reading is "the build is still running
server-side, the client just gave up" — and the natural next action, re-issuing it, would have
been wrong in the other direction. Checked instead: `pg_stat_progress_create_index` **empty**,
`pg_stat_activity` **empty**, `pg_index` **empty**. The statement had been *cancelled* with the
HTTP request; nothing was building. Rebuilt over a real TCP session (`psql`, `statement_timeout=0`)
and watched to `indisvalid=t` through the progress view — 14.5 min, 433,449 tuples, with
pgvector warning that the graph outgrew `maintenance_work_mem` at 28,596 tuples.

Had I trusted the timeout as "probably still going", the scoring run would have gone ahead
against a table with **no index** — and `score.mjs` would have said `WARNING no Index Scan` and
still produced a complete, plausible, *lower* set of numbers.

---

## RIG BUG found tonight: the checkpoint syncer never deletes

```
s3://…/models/cshl-encoder-bge-m3/20260819-232838-train/checkpoints/  352 objects  200.2 GiB
s3://…/models/cshl-encoder-bge-m3/20260819-192100-train/               31 objects   10.6 GiB
```

`train.sh`'s background syncer runs `aws s3 sync "$OUT" "$CKPT_S3/"` with **no `--delete`**.
`--save_total_limit=3` prunes the *local* disk, so the box stays healthy — but every checkpoint
it deletes locally is already in S3 and stays there forever. This run wrote 31 checkpoints at
~6.5 GiB each: **200 GiB of optimizer state from a run that completed with EXIT=0**, for which
the only useful artifact is the 2.1 GiB in `serve/`. At $0.023/GB-month that is **$4.60/month,
accruing, from one night**. It scales with `SAVE_STEPS` — tonight's tighter 400-step checkpoint
interval is exactly why this run left 19x last night's.

**Not deleted by me** — 200 GiB of Brendan's storage is his call, and the run's own weights are
independently safe in `final/` and `serve/`. One command when he wants it:
```sh
aws s3 rm --recursive s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-232838-train/checkpoints/
aws s3 rm --recursive s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-192100-train/checkpoints/
```
The durable fix belongs in `train.sh`: either `--delete` on the syncer, or a post-success
cleanup of `checkpoints/` once `final/` is verified complete. Not made mid-flight tonight.

---

## Spend ledger — FINAL, from measured instance lifetimes

Rates from the AWS pricing API. Lifetimes from `describe-instances`, not from the scripts.

| when | item | rate | minutes | $ |
|---|---|---|---:|---:|
| 02:26Z | PHASE 0 — 7 arms on the frozen 2k | — | — | 0.00 |
| 02:50Z | pricing / quota / IAM reads · 11 capacity-refused launches | — | — | 0.00 |
| 03:33Z | ANCE miner smoke test (200 queries, read-only) | — | — | 0.00 |
| 04:09Z | ANN-recall probe (300 queries) | — | — | 0.00 |
| 03:18:55–03:28:27Z | `i-0b7c04759e791d6dd` g5.12xlarge — **killed, waste** | $5.672/hr | 9.5 | **0.90** |
| 03:28:48–06:00:38Z | `i-0efe2e00b91aedceb` g6e.2xlarge — THE RUN | $2.24208/hr | 151.8 | **5.67** |
| 06:01:39–~06:09:20Z | `i-00d51fd0f63ce6242` g6e.xlarge (embed 0) | $1.861/hr | 7.7 | **0.24** |
| 06:02:00–~06:09:20Z | `i-02af1bf6e2a3cb916` g6e.xlarge (embed 1) | $1.861/hr | 7.3 | **0.23** |
| 06:02:21–~06:09:20Z | `i-0b8320cd013cbb9db` g6e.xlarge (embed 2) | $1.861/hr | 7.0 | **0.22** |
| 06:02:36–~06:09:20Z | `i-088e3a8e277a4b698` g6e.xlarge (embed 3) | $1.861/hr | 6.7 | **0.21** |
| — | S3 (1.5 GB slice, 21 GB final, 2.1 GB serve, 200 GB checkpoint syncs, requests) | — | — | ~0.10 |
| | **TOTAL** | | | **≈ 7.57** |

**Under the $12.50 cap, with ≈$4.93 unspent.** Eleven capacity-refused launches cost nothing
and left no orphans. **Zero GPU instances of this lane are running at close** — verified by
`describe-instances`, and the one GPU box that was alive during this lane's window
(`i-094b84dd57595f795`, `g6e.2xlarge`, tagged `cshl-reranker-…`) belongs to the **cshl-RR**
lane, is not my spend and is not mine to terminate.

The N=4 re-embed was the right call: **~7 minutes** end to end against the ~16 min per box the
N=2 A10G sweep took last night, for **$0.90**.

**Waste, itemised — mine, not folded into the total**

| item | $ | what happened |
|---|---:|---|
| the 4-GPU attempt | **0.90** | 9.5 min of a g5.12xlarge. `BATCH=4` OOMed on a 22 GB A10G, the guard halved to 2, and the effective batch collapsed to 8 — the same 7 in-batch negatives one GPU gives, at 1.56 s/step for a 5h22m ETA and a $30 bill. Killed on the measurement. I should have priced the A10G's memory against last night's measured 33.9 GB before putting it in the menu; the OOM guard cannot save you from a card that was never big enough. |
| 200 GiB of orphaned checkpoints | ~0.01 tonight | See the rig bug above. Trivial now, $4.60/month if nobody deletes it. |

---

# CONTINGENCY — AUTHORKW is the only remaining gap. Ranked levers, no GPU fired.

Per the brief, **no further GPU has been fired.** The gap to close is **AUTHORKW +0.0277**
(from RRF(cshl-QP2+FTS)'s 0.7800 to above MedCPT's 0.8076).

**The single most important input to this ranking is the R@50 headroom**, because it bounds
what a re-ranking lever can possibly achieve:

| arm | AUTHORKW R@10 | AUTHORKW **R@50** |
|---|---:|---:|
| RRF(cshl-QP2 + FTS) | 0.7800 | **0.8775** |
| cshl-QP2 | 0.7642 | 0.8669 |
| `ncbi/MedCPT` | 0.8076 | 0.8920 |

**87.75% of author-keyword golds are already inside our top-50** — comfortably above MedCPT's
top-10 rate of 80.76%. The information needed to win is already being retrieved; it is sitting
at ranks 11–50. That makes ordering, not recall, the binding constraint, and it changes the
ranking decisively.

### 1. Reranker (cshl-RR) over RRF(cshl-QP2 + FTS), pool 50 — **do this first**
- **Measured cost: $0.00** if the cshl-RR lane's TEI endpoint is already serving; **~$0.62**
  (one g6e.xlarge, ~20 min) if one must be stood up. Scoring is ~2,000 cross-encoder calls.
- **No code needed** — `score.mjs` already parses `rerank:<base>@<url>` as a composite arm:
  `ARMS="cshl_qp2,fts,rrf:cshl_qp2+fts,rerank:rrf_cshl_qp2+fts@http://<ip>:8081" RERANK_POOL=50`
- **Why first:** it needs to move 2.8 points out of the 9.75 points already sitting in ranks
  11–50. It is the only lever whose ceiling I have *measured* rather than guessed, it is 10x
  cheaper than anything else here, and it is the one lever tonight's surprising result does not
  argue against — a cross-encoder reads the query and document together, which is exactly the
  thing a single 1024-d bi-encoder vector cannot do for short idiosyncratic keyword sets.
- Risk to state: a reranker that is worse than the fusion's own ordering can *lower* R@10. It
  costs one scoring run to find out.

### 2. ANCE hard-negative re-mining with cshl-QP2, AUTHORKW-weighted
- **Measured cost: ~$5.99 AWS** — $0.31 to embed the training queries on one g6e.xlarge serving
  the QP2 checkpoint (~10 min), $0.00 for the mine itself (Neon only), $5.68 to retrain on the
  same box config as tonight. **Plus 3–5 h of wall-clock** for 100k x top-100 retrievals, which
  is the real cost.
- **Already drafted, smoke-tested and fenced** (`scripts/train/mine-ance.mjs`, 03:33Z).
- **Why second, and honestly weakened by tonight's result:** it changes negative *quality*
  rather than supervision *quantity*, so tonight's "6.8x the AUTHORKW data bought +0.0145,
  p=0.24" does not directly condemn it. But it is the same family of intervention, it costs 10x
  the reranker, and its `SKIP_TOP` heuristic is untested at scale.

### 3. Second epoch on the 100k slice
- **Measured cost: $5.68** (12,500 more steps, 152 box-minutes at tonight's exact throughput);
  ~$10.7 if run as `EPOCHS=2` from scratch rather than continued from tonight's weights.
- **Why last, and why I would not spend it:** it is strictly more passes over the same data,
  and tonight measured that **5.7x more data moved AUTHORKW by an amount indistinguishable from
  zero**. A second epoch over data that already failed to move the number is the least
  supported bet on the table. It would likely add a little to MeSH — where we are already
  winning by 0.0669 and do not need it.

### Not recommended, and why — so these are not re-proposed later
- **A bigger batch / cross-device negatives on a 4-GPU box.** The flag is wired and verified,
  but tonight showed g6e.12xlarge has no capacity and the 24 GB alternatives make it
  self-defeating. Revisit only if L40S multi-GPU capacity returns.
- **Fusing more of our own encoders.** Measured twice tonight: adding cshl-QP or cshl-CITE to a
  cshl-QP2 fusion makes it monotonically worse.
- **Raising `hnsw.ef_search`.** Measured at 04:09Z: costs both arms 3.1% of top-10 equally. Not
  a free win, and it would break comparability with every published digit.
