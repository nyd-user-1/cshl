# LANE-RERANK — Stage 4: the NSR cross-encoder reranker, on 44b's trainer unchanged

You are training `nsr-reranker-gte-modernbert` — the second published piece
of NSR-CPT (44b's analog: `NYSgpt/44b-reranker-gte-modernbert`, 57 % error
reduction, `~/Model/README.md`). Same trainer, same group shape, our data.
Data + weights + measurements; nothing in `src/` or `api/`.

**Dependencies.** Phase 0 (rig + conversion + rehearsal) starts now on
LANE-TRIPLETS' rehearsal slice. Phase 1 (real training) starts when
`~/Model/nsr-training-pairs/out/{train,val,test}.jsonl` + `manifest.json`
(`disjointness.pass = true`) exist. Phase 2 (scoring) needs LANE-EVAL's
frozen benchmark + its Arm-B (raw bge-m3) top-50 candidate lists.

## Non-negotiables

1. **Read first**: `44b/scripts/reranker/train.py` (whole file — it is the
   trainer; note `train.py:68/175`: if `<dir>/train-groups.jsonl` exists it is
   reused verbatim and the built-in miner is skipped — that is HOW our bge-m3
   negatives reach the GPU; never let it mine with `--retriever`),
   `44b/scripts/pairs-to-groups.mjs` (the converter — reuse it, its held-out
   re-check included), `44b/scripts/reranker/score_eval.py` (the scorer),
   `~/Model/README.md`, `~/Model/44b-reranker/train-gte.log` (precedent:
   24,177 groups × 7 negs, 2 epochs, 5,000 s, g6.xlarge), `docs/prompts/
   LANE-TRAIN.md` (the rig you copy — `scripts/train-nsr/launch.sh` /
   `train.sh` after its attempt-3 fixes; **use the PyTorch DLAMI, not the base one** —
   `ami-012ba162b9cd2729c` "Deep Learning OSS Nvidia Driver AMI GPU PyTorch
   2.7 (Ubuntu 22.04)", the AMI 44b's trainer ran on
   (`44b/scripts/reranker/provision-gpu-box.sh:18`); torch/CUDA/`python`
   preinstalled — the base DLAMI cost LANE-TRAIN four failed boots),
   `docs/prompts/LANE-EVAL.md` (segments, arms), the memory law "hard
   negatives from OUR retriever's space".
2. **Reuse, don't rewrite.** `train.py` runs unchanged (path flags only:
   `--dir ~/Model/nsr-reranker --base Alibaba-NLP/gte-reranker-modernbert-base
   --epochs 2 --bulk 0 --max-hours 1.5`). `--bulk 0` — 44b's title↔abstract
   self-supervision is not our signal. If a change is genuinely required,
   patch minimally and write the diff in REPORT.
3. **Never on the laptop / no browsers / no `npx` / no `find /`.**
   Conversion scripts are jsonl-only and may run here; the model side never.
4. **Secrets** via SSM as the rig does; xtrace off (the rigs leaked the DB URL
   into S3 logs tonight — fixed in `dfcbb25`; do not reintroduce `set -x`).
5. **Credits are money.** g6e.xlarge $1.861/h. Projection from the rehearsal's
   measured groups/s BEFORE launch. **Hard cap for the lane: $5.00 actual.**
   Precedent arithmetic (NOT a measurement): 193k pairs / 5,000 s → 60k
   pairs ≈ 26 min ≈ $0.80 + boot. Report projected AND actual.
6. **Never train on the eval**: LANE-EVAL's held-out papers absent from
   groups (assert, paste count); `pairs-to-groups.mjs`' val/test guard stays.
7. **Do not commit, do not push.** Weights → `s3://nsr-embed-v2/models/
   nsr-reranker-gte-modernbert/<run-id>/`, sync to `~/Model/nsr-reranker/`.
   Report by editing REPORT.

## Phase 0 — rig, conversion, rehearsal (start now)

- `scripts/rerank-nsr/{launch.sh,train.sh}` from `scripts/train-nsr/`
  (MODE=rehearse|train); box-side: torch + `sentence-transformers
  transformers accelerate` (whatever `train.py` imports — read its imports and
  install exactly those), pull `train-groups.jsonl` from S3, run `train.py`,
  upload `model/final` + `train.log`, terminate. Watchdog as the rig.
- Conversion: run `44b/scripts/pairs-to-groups.mjs --in ~/Model/
  nsr-training-pairs/out --out ~/Model/nsr-reranker` (its `{q,pos,negs[]}`
  output is what `train.py` opens). If our record's `meta`/`family` keys
  confuse it, patch minimally, note the diff.
- Rehearse on B's slice: build the 1,000 rehearsal records exactly as C did
  (`scripts/train-nsr/build-rehearsal-records.mjs` — reuse it), convert, 1
  epoch, measure groups/s and wall-clock, EXIT=0, model saves and loads.
- **Gate 0 (GO-IF-GREEN):** EXIT=0; projected full run (60k groups × 2
  epochs at measured groups/s + boot) ≤ **90 min** (lead re-set 01:22 — this
  lane is not on the critical path; it waits on LANE-TRIPLETS' train.jsonl
  like LANE-TRAIN does) and ≤ $5. Red → HALT.

## Phase 1 — train

- Groups: LANE-TRAIN's 60-min pair budget (same ~60k pairs — all EX + the
  stratified KW sample; read the exact ids from LANE-TRAIN's REPORT/manifest
  so both models train on the identical set), 7 negatives per group (drop
  groups with < 4). 2 epochs (44b's precedent). Checkpoint per epoch to S3.
- Output: `final/`, `run.json` {base, groups, epochs, wall-clock s,
  instance-hours, $}.

## Phase 2 — score on the frozen eval (same box, before shutdown)

- Candidate pools: LANE-EVAL's Arm-B top-50 per query (`data/eval/
  nsr-eval-v1/results/armB*.json` or regenerate from `nsr_embeddings` with the
  same SQL). Rerank with `final/`; report per family × segment: Recall@1/5/10,
  MRR, nDCG@10 for **B (raw order)** vs **B+reranker**; also rerank the RRF
  pool. `score_eval.py` pattern; latency per query on the L40S and per-query
  on CPU (t4g-class, `bench_cpu.py`) — the serving decision needs both.
- **Gate 2 (write per segment):** ship-worthy iff reranked ≥ raw on
  Recall@10 and nDCG@10 in every segment and ≥ 10 % relative on blended KW
  (44b's rule); a segment loss is a result, not a failure — say where.
- Box `terminated`, weights + log in S3, Neon floor untouched by this lane.

## REPORT

> **LEAD NOTE 03:31** — the 03:28 duplicate box (`i-0995245224718702f`, run 032837) was terminated by the lead; the authoritative re-run is `nsr-reranker-20260817-032126-train` (`i-03e00a655e21d274c`, same fixed train.sh, same seed/data). Score its `models/…/032126-train/reranked-*.json` when it lands (`scripts/eval/score-rerank.mjs`). Do NOT launch another box.

_(edit as you go; the lead reads it verbatim)_

- Status: **CLOSED. Gate 2 GREEN — `nsr-reranker-gte-modernbert` is
  ship-worthy per the brief's own rule.** Phases 0/1/2 all complete: rig
  built and rehearsed (Phase 0), trained on the shared 39,600-pair sample
  derived here and reused by LANE-TRAIN (Phase 1, `run_id
  20260817-032126-train`), scored against LANE-EVAL's live frozen benchmark
  — reranked beats raw bge-m3 on Recall@10 and nDCG@10 in **every segment of
  both families**, blended KW nDCG@10 +76% relative (Phase 2, full tables
  below). Weights + rerank results in S3
  (`s3://nsr-embed-v2/models/nsr-reranker-gte-modernbert/
  20260817-032126-train/final/`). Total spend ≈$3.36 of the $5 cap. Open,
  non-blocking items for the lead: 1-epoch-not-2 deviation, CPU latency
  unmeasured, `~/Model/nsr-reranker/` sync not yet pulled — see bottom of
  this REPORT. **Narrative below is kept in chronological order** (Phase 0
  rehearsal → dependency wait → LANE-TRIPLETS' data landing → the shared
  39,600 sample → the IAM-gap incident and its fix → the final scored run)
  since later entries reference earlier ones.

- **Required reading (non-negotiable #1) completed**: `44b/scripts/reranker/
  train.py` (253 lines, whole file — confirmed train.py:67-68/174-175: mining
  block is entirely skipped whenever `<dir>/train-groups.jsonl` exists on
  disk before train.py runs; only `torch`/`numpy`/`transformers` are actually
  imported on that path, `scipy`/`sentence_transformers` never load), `44b/
  scripts/pairs-to-groups.mjs` (110 lines), `44b/scripts/reranker/
  score_eval.py` (131 lines — 44b-specific eval shape (`eval-frozen.jsonl`,
  paper/patent tracks); not runnable as-is against NSR's benchmark, used as a
  scoring-pattern reference only, per the brief's own "score_eval.py pattern"
  wording, not "run score_eval.py"), `~/Model/README.md`, `~/Model/44b-
  reranker/train-gte.log` (confirms precedent: 24,177 groups × 7 negs, 2
  epochs, 6,045 steps/epoch, group=8/batch=32, EXIT=0, 5,000.0s wall-clock on
  g6.xlarge/A10G), `docs/prompts/LANE-TRAIN.md` REPORT in full (rig pattern
  copied; also the source of the "PyTorch DLAMI has no torch host package"
  finding reused below), `docs/prompts/LANE-EVAL.md` REPORT in full (Status
  CLOSED, Arms A/B/RRF scored, `data/eval/nsr-eval-v1/` frozen), memory
  [[nsr-model-phase-doctrine]] ("hard negatives must be mined from OUR
  retriever's space" — satisfied: LANE-TRIPLETS mined negatives from bge-m3,
  the corpus's own embedding space, per its own REPORT).

- **Dependency check, done directly against disk/S3, not assumed**:
  - LANE-TRIPLETS: `~/Model/nsr-training-pairs/out/` has only `rehearsal/`
    (9 files) — no `train.jsonl`/`val.jsonl`/`test.jsonl`/`manifest.json`.
    **Phase 1 blocked.**
  - LANE-EVAL: `data/eval/nsr-eval-v1/{queries.jsonl,qrels.tsv,manifest.json,
    results/{A,B,RRF}.json}` all present, REPORT Status **CLOSED**. **Phase 2
    data dependency satisfied**, with one wrinkle: `results/B.json` holds
    only aggregate metrics (Recall/MRR/nDCG per segment), **not per-query
    top-50 candidate lists** — the brief's own fallback applies ("or
    regenerate from `nsr_embeddings` with the same SQL"). `train.sh`'s
    MODE=train scoring step regenerates the Arm-B pool live via
    `nsr_eval_queries` (bge-m3 embeddings, already populated by LANE-EVAL
    Phase 2) joined to `nsr_embeddings` with LANE-EVAL's own Arm-B SQL shape
    (`SET LOCAL hnsw.ef_search = 100; ... ORDER BY embedding <=> $1::vector
    LIMIT 50`, read from `scripts/eval/score.mjs:198`) — written against a
    live table now confirmed to exist, but not yet executed (Phase 1 hasn't
    produced a `final/` to score with), so **not yet run, re-verify when
    Phase 1 completes.**

- **Phase 0 files written** (`scripts/rerank-nsr/`), all syntax-checked
  (`bash -n`, `node --check`, `compile()` on every embedded Python heredoc —
  all pass):
  - `pairs-to-groups.mjs` (177 lines) — our own copy of `44b/scripts/
    pairs-to-groups.mjs`, patched minimally for LANE-TRIPLETS' record shape
    (non-negotiable #2's "patch minimally, note the diff" — the 44b repo's
    original file was NOT edited, this is a new file in our repo). Diff from
    the 44b original, documented in the file's own header:
    1. `paper_slug` derived as `r.positive.slug` (LANE-TRIPLETS records carry
       no top-level `paper_slug`).
    2. `src` derived as `r.meta.family` (KW/EX), not `r.kind`.
    3. **Held-out source changed.** The 44b original reads `${IN}/val.jsonl`
       + `${IN}/test.jsonl` for its held-out guard. LANE-TRIPLETS' rehearsal
       slice (`rehearsal.jsonl`) is a single file with no val/test split (that
       split only exists for the real Phase-1 train/val/test, not yet
       produced). Added `--heldout <qrels.tsv>` to read LANE-EVAL's frozen
       qrels (col 2 = key_number) as the held-out universe instead — the
       authoritative source, since LANE-TRIPLETS' own Phase-3 REPORT
       independently re-derived its full holdout key-set two ways and
       matched LANE-EVAL's formula byte-for-byte (sha256
       `51310096b8a4f69eee49c5e1e7463782c48a48094b49af092b98f5fed7424835`,
       Gate PASS). **Caveat for Phase 1**: `qrels.tsv`'s 11,048 rows only
       cover the **sampled eval queries' positives** (10,038 distinct papers
       — the papers that ended up as one of the 9,995 frozen queries'
       answers), a strict subset of LANE-EVAL's full 46,200/47,646-key
       held-out *universe* (every paper in the first quartile of the hash,
       not just the sampled ones). Good enough for the rehearsal exercise
       (it isn't the shipped model); **for the real Phase 1 run, point `--in`
       at LANE-TRIPLETS' output directory once it exists** — the script
       already unions in `${IN}/val.jsonl` + `${IN}/test.jsonl`'s
       `paper_slug`s on top of `--heldout`, which is LANE-TRIPLETS' own
       verified-correct disjointness split and the right primary source; keep
       `--heldout qrels.tsv` too as a second, redundant check (never a
       narrower guard than either alone).
  - `launch.sh` (117 lines) — copy of `scripts/train-nsr/launch.sh`'s
    role/SG/SSM/S3/self-terminate/SUBNET/AMI shape, repointed at
    `s3://nsr-embed-v2/reranker/` for `train.py`+`train.sh`+groups instead of
    the FlagEmbedding jsonl path. IAM: **no delta needed** — checked
    read-only before launch (`aws iam get-role-policy --role-name nsr-embed
    --policy-name read-dburl`), existing policy already grants read on the
    whole bucket and write on both `logs/*` and `models/*` (applied by
    LANE-TRAIN earlier tonight); `reranker/*` and `reranker/results/*` live
    under the same bucket the wildcard covers.
  - `train.sh` (139 lines as first written; +6 lines / 1-word fix after
    attempt 1, see Deviations) — box-side: installs deps, pulls `train.py`
    (unchanged, per non-negotiable #2) + a pre-converted `train-groups.jsonl`
    from S3 so train.py's own miner never runs, trains with the pinned flags
    (`--base Alibaba-NLP/gte-reranker-modernbert-base --bulk 0`,
    `--epochs`/`--max-hours` from env), measures groups/s from the log's own
    timestamps, verifies the saved model reloads and scores a sanity pair,
    and (MODE=train only) reranks LANE-EVAL's live Arm-B pool per query
    before upload. `EPOCHS`/`MAXHOURS` env passthrough was missing from
    `launch.sh`'s user-data on the first write — fixed before it mattered
    (train.sh's own defaults, 1 epoch / 0.5h, happened to match what the
    rehearsal needed, so nothing bad ran, but a real Phase-1 override would
    have been silently ignored until this fix).

- **Conversion** (laptop-safe, jsonl-only, non-negotiable #3):
  `node scripts/rerank-nsr/pairs-to-groups.mjs --in ~/Model/nsr-training-pairs/
  out/rehearsal/rehearsal.jsonl --heldout data/eval/nsr-eval-v1/qrels.tsv --out
  ~/Model/nsr-reranker/rehearsal --apply`. **Input file note**: used
  `rehearsal.jsonl` (LANE-TRIPLETS' own canonical rehearsal deliverable,
  `slug`-keyed, per its REPORT: "Rehearsal deliverable for LANE-TRAIN... slug
  used instead of key_number to stay byte-compatible"), **not**
  `rehearsal.records.jsonl` in the same directory — LANE-TRIPLETS' own REPORT
  flags that second file as a stray artifact from "a prior or concurrent
  attempt at this same lane... under different code" with no known author;
  it turned out to be LANE-TRAIN's own `build-rehearsal-records.mjs` output
  (`key_number`-keyed), a different reshaping for a different consumer
  (FlagEmbedding), not LANE-TRIPLETS' deliverable. Using it here would have
  been wrong.
  - Result: **994/1,000 groups written**, 7.52 negatives/group avg (`EX: 98,
    KW: 896`). Held-out guard, run against qrels.tsv (10,038 distinct
    papers): **6 positives dropped for being themselves held out**, **467
    negatives dropped for landing on a held-out paper**, 0 groups emptied, 0
    train-papers found in the held-out set after filtering (assertion
    passed). The 6-positive catch is a real finding: 6 of LANE-TRIPLETS'
    1,000 rehearsal anchors used a held-out paper as their own positive —
    correctly excluded here; worth flagging to LANE-TRIPLETS since their
    rehearsal is meant to be disjoint from the eval by construction.
  - Uploaded: `s3://nsr-embed-v2/reranker/train/rehearsal/train-groups.jsonl`
    (994 lines, 2,378,913 bytes).

- **Phase 0 rehearsal runs**:
  - **Attempt 1 FAILED** (`run_id 20260817-011040-rehearse`, instance
    `i-086f0e4782212a492`, ~1-2 min uptime, self-terminated on schedule,
    negligible cost): `ModuleNotFoundError: No module named 'torch'` at
    train.py's top-level `import torch`. **This contradicts LANE-RERANK
    non-negotiable #1's own claim** ("torch/CUDA/`python` preinstalled" on
    the PyTorch DLAMI) — but matches a finding LANE-TRAIN independently made
    on this exact AMI earlier tonight (its REPORT: "this DLAMI does not ship
    torch as a host Python package at all... LANE-EMBED never needed one, it
    only ran TEI in Docker"). Should have cross-applied that finding before
    the first launch instead of trusting the brief's claim; didn't cost more
    than one cheap failed boot. **Fix**: `train.sh` now runs
    `pip install -U torch transformers psycopg2-binary` explicitly (torch is
    a genuine ~2GB fresh download every boot on this AMI, unavoidable).
  - **Attempt 2 SUCCEEDED**: `run_id 20260817-011223-rehearse`, instance
    `i-00df74884379ce254`. `device=cuda NVIDIA L40S` confirmed. `groups 994 =
    {'EX': 98, 'KW': 896} (7952 pairs)`. `training: 125 steps (125/epoch),
    group=8, batch=64 pairs`. **train.py EXIT=0, wall-clock=55s.** Model
    saved to `model/final`, reloaded via a fresh `AutoModelForSequenceClass
    ification.from_pretrained`, scored one sanity pair (logit=1.3657) —
    **saves and loads confirmed**. Zero `postgresql://` hits in the uploaded
    log (credential-leak fix from commit `dfcbb25`/`set +x` held).
  - **Measured throughput**: training start (device+model load) to epoch-done
    = 16.1s → 54.0s = 37.9s for 125 steps = **3.30 steps/s → 26.4 groups/s**
    (group=8/step) on one L40S. Cross-checked against the one interior log
    line (step 100/125 at 46.5s: 30.4s for 100 steps = 3.29 steps/s) —
    consistent.

- **Gate 0 verdict, updated: GREEN.** Lead re-set the wall-clock bound to
  ≤90 min at 01:22 ("this lane is not on the critical path; it waits on
  LANE-TRIPLETS' train.jsonl like LANE-TRAIN does"), which the ~79-min
  projection below clears with margin; the epoch-count question (2 vs 1) is
  moot — proceeding with the pinned `--epochs 2`. Original RED-on-45-min
  finding kept below for the record:
  - Projection: 60,000 groups × 2 epochs (non-negotiable #2's pinned
    `--epochs 2`) ÷ 26.4 groups/s = **4,545s = 75.8 min** of `train.py`
    compute, + this run's own measured boot/setup overhead (total instance
    life ~258s − 55s of train.py = **~3.4 min** boot+pip+model-download,
    roughly constant regardless of data size) ≈ **~79 min total**, vs the
    brief's **≤45 min** target. **Spend at that wall-clock**: 79 min ×
    $1.861/60 ≈ **$2.46** — well under the lane's $5 hard cap, so the AND
    condition fails on wall-clock only, not on money.
  - Two honest caveats on the measurement itself, both cutting the same
    direction (the real run may be *slower* than this projection, not
    faster): (a) most rehearsal negatives have `"abstract": null` (title-only
    text, short sequences) — the real 60k set's KW `has-abstract` segment
    will include longer sequences, likely lowering throughput; (b) `group=8`
    here came out to 7.52 real negatives/group after the held-out drop
    (padded by repetition per train.py:224-227), close enough to nominal 8
    that it shouldn't matter much.
  - This is the brief's own #6 in its Gate-0 sentence ("Red → HALT") with no
    stated escape valve (unlike LANE-TRAIN's Gate 1, which explicitly allows
    re-projecting after applying levers). **Not overriding this
    unilaterally** — `--epochs 2` is one of non-negotiable #2's pinned flags,
    not offered as a dial in this brief the way LANE-TRAIN treated epoch
    count for the encoder. Options for the lead, not chosen here: (i) accept
    ~79 min / ~$2.46 as the real cost of 2 epochs on 60k groups (still 5x
    under the wall-clock brief's *intent* reads as a soft target given the
    spend cap has so much headroom); (ii) 1 epoch only (~38 min, GREEN on
    both) as a first run, matching how LANE-TRAIN downgraded the encoder's
    epoch count when its own arithmetic didn't fit; (iii) a bigger box
    (g6e.2xlarge/4xlarge, more $/hr but same wall-clock arithmetic doesn't
    change without multi-GPU — `train.py` has no `torchrun`/DDP path, so a
    bigger single GPU is the only lever, and L40S is already the top of the
    g6e family).

- **LANE-TRIPLETS' full sweep landed (2026-08-17 06:02:29Z), Phase 1 UNBLOCKED.**
  `~/Model/nsr-training-pairs/out/{train,val,test}.jsonl` + `manifest.json`
  now exist. `manifest.json`: `disjointness.pass: true` (train_val=0,
  train_test=0, val_test=0, positive_in_own_negatives=0), holdout key_count
  46,200 (sha256 `51310096b8...` — matches LANE-EVAL's independently, per
  LANE-TRIPLETS' own Phase-3 verification). **Explicitly a partial handoff**,
  not the final sweep: `manifest.json` says `"partial": true, "coverage":
  {"anchors_mined": 93900, "anchors_total": 152006, "pct": 61.77}` —
  LANE-TRIPLETS reordered its mining to **EX first (~15k, small), then KW**
  specifically so a partial assemble could unblock LANE-TRAIN/LANE-RERANK
  before the full sweep finishes (its REPORT, verbatim: "requested so a
  partial assemble can cover all of EX quickly and unblock LANE-TRAIN/
  LANE-RERANK before the full sweep finishes"). Record shape confirmed
  identical to the rehearsal's `rehearsal.jsonl` (slug-keyed) — no format
  surprises.

- **CRITICAL FINDING: `train.jsonl` contains 1,029 records whose own
  positive is a LANE-EVAL held-out paper — a real train/eval contamination
  bug, not a hypothetical.** Ran `pairs-to-groups.mjs` as a dry run against
  the real directory first (`--in ~/Model/nsr-training-pairs/out --heldout
  data/eval/nsr-eval-v1/qrels.tsv`, nothing written) specifically to sanity
  check before spending anything, and the held-out guard caught this:
  `75,097` records → **`1,029` positives dropped for being themselves held
  out** (in addition to `80,960` negatives dropped for landing on a
  held-out paper, which is expected/routine). Verified this is not a bug in
  my own guard, three ways: (1) `train_val`/`train_test` disjointness in
  LANE-TRIPLETS' own manifest is `0` (their internal 80/10/10 split is
  clean), so none of the 1,029 come from val/test bleeding into train — they
  are exclusively matches against the `qrels.tsv`-derived set, which is a
  **strict subset** of LANE-TRIPLETS' own claimed 46,200-key holdout
  universe, so a hit there is unambiguously a hit against the real universe
  too, not an artifact of using a smaller stand-in set; (2) spot-checked one
  concretely: paper `1977GL04` is `train.jsonl`'s positive for a KW anchor
  (`"NUCLEAR REACTIONS $^{161}$Dy,$^{163}$Dy..."`) **and** is independently
  confirmed in `qrels.tsv` as the gold answer for two live EX eval queries
  (`EX-30298`, `EX-30299`) — the same paper is simultaneously a training
  target and a benchmark answer key; (3) four more examples pulled the same
  way, all real. **This means LANE-TRIPLETS' own `disjointness.pass: true`
  gate does not check disjointness against LANE-EVAL's held-out universe at
  all** — it only checks train/val/test mutual exclusivity and
  `positive_in_own_negatives`, neither of which would catch this. **Any
  consumer of `train.jsonl` that doesn't independently re-apply a held-out
  guard (this lane's `pairs-to-groups.mjs` / `select-shared-sample.mjs` both
  do) will train on ~1.4% of the anchors it's supposed to be evaluated
  against** — for LANE-TRAIN's encoder this would inflate its own Arm-D
  numbers against LANE-EVAL's frozen benchmark and invalidate the Gate-3
  comparison if its `to-flag.mjs` (which has no held-out check at all, only
  a `<4 negatives` filter) is pointed at raw `train.jsonl` without going
  through an equivalent guard first. **Not this lane's file to fix** —
  flagged to the user directly outside this file, and both this lane's own
  guards already exclude it.

- **Shared 39,600-pair training sample — derived here, now the canonical
  source for both models (lead directive, 2026-08-17 02:1x).** LANE-TRAIN's
  own REPORT (read in full) had already worked out the real shared budget
  from its own measured throughput — "all EX pairs (~15k) fit comfortably,
  KW gets sampled down to fill the remainder... the real Phase 2 pair budget
  is ~39,600, not ~60,000" — but its Phase 2 (which would assemble the
  concrete id list) had not run yet as of this read (its REPORT still said
  "Phase 2/3: still blocked", written before LANE-TRIPLETS' data landed).
  Rather than wait on a live cross-window race or invent an independent
  number, wrote `scripts/rerank-nsr/select-shared-sample.mjs` (new, 130
  lines) implementing LANE-TRAIN's own documented method exactly: **all**
  clean EX groups (after the held-out guard) + KW stratified across the 15
  era×richness×reftype cells with a floor-then-proportional policy (floor
  100/cell or the whole cell if smaller — same policy LANE-EVAL used for its
  own eval sample), selection within each cell deterministic (sorted by
  `positive.slug`, first N) so re-running reproduces the identical sample
  byte-for-byte (verified: two runs, same sha256).
  - Result: **11,812 clean EX (all of it) + 27,788 stratified KW = 39,600
    exactly**, held-out guard applied first (drops the 1,029 contaminated
    positives + negatives landing on held-out papers, same as above). Every
    KW cell down to size-2 cells preserved (floor caught them, not zeroed
    out by proportional rounding).
  - **Lead directive, addressed**: wrote the exact selection to
    `~/Model/nsr-training-pairs/out/train-budget-ids.json` — `39,600`
    `{family, id}` pairs (11,812 EX + 27,788 KW), so **LANE-TRAIN reuses this
    file rather than re-deriving its own** (byte-identical supervision,
    verified reproducible via sha256
    `d67e0d91079b022cb6bf8072f7f937d4f7a3c57b644c288836ec90b9aedd9a3c` over
    the sorted id list — also written in
    `~/Model/nsr-reranker/shared-39600/sample-manifest.json` alongside the
    per-cell breakdown, for LANE-TRAIN to cross-check its own reuse against).
  - Uploaded: `s3://nsr-embed-v2/reranker/train/shared-39600/
    {train-groups.jsonl (85.3 MiB, 39,600 lines), sample-manifest.json}`.

- **Phase 1 LAUNCHED**: `MODE=train TRAIN_NAME=shared-39600 WATCHDOG_MIN=150
  EPOCHS=2 MAXHOURS=1.5`, `run_id 20260817-021258-train`, instance
  `i-07a1468b153330ff4`. Projection before launch (non-negotiable #5, from
  the rehearsal's measured 26.4 groups/s, not a guess): 39,600 groups × 2
  epochs ÷ 26.4 groups/s = 3,000s (50.0 min) compute + ~3.5 min boot/setup ≈
  **53.5 min, ≈$1.66** for training alone — clears Gate 0's 90-min bound with
  large margin. Phase 2 scoring time on top is **not separately projected**
  (no live measurement exists yet — 9,995 queries × per-query DB round-trip
  + cross-encoder inference on 50 candidates each, unknown throughput);
  `WATCHDOG_MIN=150` (worst case ≈$4.65, still under the $5 lane cap) sized
  to cover training's own `--max-hours 1.5` safety net (in case real
  throughput is worse than the rehearsal's title-only-heavy sample) **plus**
  an unmeasured Phase 2 on top, with margin.
  - **Robustness fix applied before launch**: the whole script runs under
    `set -euo pipefail`; the Phase 2 scoring Python block is genuinely
    unverified end-to-end (schema was checked live — see below — but the
    scoring logic itself never ran against real data before this launch).
    Without a guard, any exception there would abort the script before step
    6 (weight upload), losing the actual trained model over a scoring bug.
    Wrapped it: `python3 ... <<'PY' || echo "WARNING: ... non-fatal"` so a
    Phase 2 failure can't take the weights down with it.
  - **DB schema verified live before launch** (laptop, DB-only Node script,
    non-negotiable #3): `nsr_eval_queries` columns confirmed exactly
    `qid, family, text, embedding, embedded_at, embedding_commercial,
    embedded_commercial_at` (the four `train.sh` reads all present, correct
    types); `9,995` rows with `embedding IS NOT NULL` (matches LANE-EVAL's
    reported count); `nsr_embeddings_embedding_idx` confirmed present (the
    HNSW index the Arm-B kNN in `train.sh` depends on).
  - Monitoring now (background poll + scheduled wakeups); will update this
    REPORT with wall-clock, loss curve, EXIT code, and — if Phase 2 also
    lands — the per-segment tables the moment the box's log uploads.

- **INCIDENT: run `20260817-021258-train` completed all real work and then
  lost everything to an IAM gap — root cause mine, fixed by the lead
  directly in `train.sh`.** Confirmed via SSM (`ps aux`, live tail) that
  training finished cleanly (`train.py EXIT=0, wall-clock=2558s` = 42.6 min)
  and Phase 2 scoring then ran ALL THE WAY through **9,995/9,995** eval
  queries (log: `[score] 9995 eval queries` ... `[score] wrote
  /opt/reranker/reranked-20260817-021258-train.json (9995 queries)`,
  throughput climbing to 12.3 q/s steady-state) — both phases genuinely
  succeeded. Then: `upload failed: ... reranked-20260817-021258-train.json
  ... AccessDenied ... not authorized to perform: s3:PutObject on resource
  "arn:aws:s3:::nsr-embed-v2/reranker/results/..." because no identity-based
  policy allows the s3:PutObject action`. **My bug**: Phase 0's IAM
  read-only check (non-negotiable, done before any launch) verified
  `models/*` and `logs/*` were writable — both already covered by the
  policy LANE-TRAIN's launch.sh applied — but I introduced a **third,
  unchecked prefix** (`reranker/results/*`) for Phase 2's output in
  `train.sh` without re-verifying IAM covered it. It didn't. The `aws s3 cp`
  to that prefix failed, and because it ran **before** the weights upload in
  step 6, under `set -euo pipefail` with no `|| true` guard, the script
  exited right there — **step 6 (weights upload) never ran**. The outer
  `launch.sh` user-data has no `set -e` of its own, so it continued past the
  failed `train.sh`, uploaded the (still-successful) outer log, and hit
  `shutdown -h now` on schedule. Box terminated with the trained model and
  the completed rerank results both still only on its `DeleteOnTermination`
  volume — unrecoverable. Confirmed directly: `s3://nsr-embed-v2/models/
  nsr-reranker-gte-modernbert/20260817-021258-train/` **empty**,
  `s3://nsr-embed-v2/reranker/results/` **empty**. Credential leak check on
  the recovered outer log: 0 `postgresql://` hits (that guard held).
  - **Cost of the loss**: log uploaded (≈ shutdown time) at 07:11:38Z,
    launched 06:13:05Z → **≈58.6 min instance life ≈ $1.83**, for a run that
    did everything right except the last upload.
  - **Lead's fix** (applied directly to `scripts/rerank-nsr/train.sh`,
    verified by reading the file, `bash -n` + heredoc `compile()` re-checked
    clean after): step 6 now uploads weights to `models/.../final/`
    **first** (still unguarded — if this fails, we need to know loudly, not
    silently lose the run again), a redundant recursive copy of the whole
    model dir with `|| true`, **then reroutes the rerank-results JSON to
    `s3://.../models/nsr-reranker-gte-modernbert/<run-id>/reranked-<run-id>
    .json`** — under the already-covered `models/*` prefix instead of the
    uncovered `reranker/results/*` one, so the fix needs **no new IAM policy
    at all** — with `|| true`, then the inner log with `|| true`. This is a
    better fix than just adding `|| true` everywhere: it removes the
    permission gap entirely rather than papering over it.
  - **Process lesson for this lane, not just this file**: Phase 0's IAM
    verification checked the prefixes the brief anticipated (`models/*`,
    `logs/*`) but I later introduced a new prefix in Phase 2 code without
    circling back to re-verify — a one-time IAM check at Phase 0 doesn't
    cover S3 paths invented afterward. The lead's fix sidesteps this
    correctly (reuse an already-granted prefix) rather than requiring a
    fresh IAM delta for `reranker/results/*`, which is the better call here.
  - **Relaunched**: `run_id 20260817-032837-train`, instance
    `i-0995245224718702f`, same config (`MODE=train TRAIN_NAME=shared-39600
    WATCHDOG_MIN=150 EPOCHS=2 MAXHOURS=1.5`), same `train-groups.jsonl`
    (unchanged in S3, no need to reconvert). Projection this time uses the
    FAILED run's own real measurements, not the rehearsal's: training
    2,558s + scoring ≈900s (9,995 queries at the observed climbing-to-12.3
    q/s rate) + boot ≈3.5 min ≈ **~61 min total, ≈$1.89** — tighter and more
    confident than the earlier rehearsal-based projection, and it already
    proved the whole pipeline works end-to-end once, short of the one upload
    bug now fixed.
  - **Duplicate caught by the lead**: unbeknownst to this window, another
    run (`nsr-reranker-20260817-032126-train`, instance `i-03e00a655e21d274c`,
    launched 07:21:54Z, **before** my 07:28:37Z relaunch) had already been
    started with the same fixed `train.sh` — my relaunch was a race, not
    a needed second attempt. **Lead terminated my duplicate box
    (`i-0995245224718702f`) at 03:31** and left the note above pointing at
    `20260817-032126-train` as the authoritative run, plus a new scorer
    (`scripts/eval/score-rerank.mjs`, written outside this window — read in
    full: computes Recall@1/5/10/MRR/nDCG@10 per family×segment from a
    `reranked-<run>.json`, against `qrels.tsv`/`queries.jsonl`, prints the
    Gate 2 table, matches this lane's Gate 2 bar exactly). **Not launching
    another box, per the lead's explicit instruction** — watching
    `20260817-032126-train` / `i-03e00a655e21d274c` (running as of this
    read, launched 07:21:54Z) and will score its output with
    `score-rerank.mjs` the moment `models/nsr-reranker-gte-modernbert/
    20260817-032126-train/reranked-20260817-032126-train.json` lands in S3.
  - **Flag, not acted on (no relaunch per the lead's instruction): this
    authoritative run appears to have trained 1 epoch, not the pinned 2.**
    SSM live-tail at 23.9 min elapsed showed `train.py EXIT=0
    wall-clock=1283s` — about half my (2-epoch) failed run's 2,558s — with
    only a single `epoch 1 done → .../model/epoch-1` line before `done →
    .../model/final` (a real 2-epoch run prints both `epoch 1 done` and
    `epoch 2 done`; this shows just one), and the log's own projection line
    reads `60000 groups x 1 epoch(s)`. Likely cause: `train.sh`'s `EPOCHS`
    defaults to `${EPOCHS:-1}` when not passed explicitly by the launcher —
    my own launches set `EPOCHS=2` on the command line each time; if this
    run's launch omitted it, the default silently applied. Not fixed here
    (would mean relaunching, which the lead said not to do) — noted for the
    lead to weigh against non-negotiable #2's pinned `--epochs 2`.

- **Phase 1 + Phase 2 COMPLETE, both landed cleanly.** `run_id
  20260817-032126-train`, instance `i-03e00a655e21d274c`. `train.py EXIT=0`,
  `wall-clock=1283s` (21.4 min), `groups 39600 = {'EX': 11812, 'KW': 27788}
  (316800 pairs)`, confirmed **1 epoch** (4,950 steps, `epoch 0 step
  4900/4950 loss 0.5411` the last logged line, then straight to `done →
  .../model/final` — no second epoch). Loss curve (every 100 steps, first
  three / last three of the single epoch): `1.1373, 0.7071, 0.8637 → …→
  0.5574, 0.6113, 0.5411` — drops sharply then plateaus in the 0.5-0.6 range,
  the expected shape for one pass. Model saved+loaded OK
  (`sanity logit=-3.3808`). Phase 2 scored **9,995/9,995** eval queries
  (climbing to steady-state ~10.2 q/s), wrote `reranked-<run>.json`. **Both
  weights and results landed in S3 this time** — the lead's IAM-gap fix
  held: `models/nsr-reranker-gte-modernbert/20260817-032126-train/{checkpoint,
  epoch-1,final}/` (598,436,708-byte `model.safetensors` each) +
  `reranked-20260817-032126-train.json` (13,247,472 bytes) all present.
  Credential check on the outer log: 0 `postgresql://` hits. Instance
  reached `terminated`.

- **Gate 2 scored** (`node scripts/eval/score-rerank.mjs
  /tmp/reranked-032126.json --out data/eval/nsr-eval-v1/results/RR.json`,
  the lead's scorer — read in full, confirmed it does exactly what the
  brief's Gate 2 asks: paired raw-vs-reranked on the *same* top-50 list per
  query, Recall@1/5/10/50, MRR, nDCG@10, blended + every segment):

  **KW family (n=4,998) — raw bge-m3 top-50 vs +reranker (R@1 / R@10 / nDCG@10):**

  | segment | n | raw | reranked | ΔR@10 |
  |---|---:|---|---|---:|
  | blended | 4998 | 0.080 / 0.171 / 0.121 | **0.180 / 0.241 / 0.213** | +42% ✓ |
  | era:pre1970 | 602 | 0.022 / 0.076 / 0.045 | **0.090 / 0.128 / 0.107** | +67% ✓ |
  | era:1970-1999 | 2686 | 0.067 / 0.152 / 0.105 | **0.164 / 0.225 / 0.197** | +48% ✓ |
  | era:2000+ | 1710 | 0.121 / 0.232 / 0.174 | **0.236 / 0.307 / 0.274** | +32% ✓ |
  | richness:has-abstract | 857 | 0.222 / 0.383 / 0.296 | **0.389 / 0.477 / 0.436** | +25% ✓ |
  | richness:title-only | 4141 | 0.051 / 0.127 / 0.085 | **0.136 / 0.193 / 0.167** | +52% ✓ |
  | reftype:journal | 4250 | 0.087 / 0.179 / 0.129 | **0.188 / 0.250 / 0.221** | +39% ✓ |
  | reftype:other | 748 | 0.039 / 0.120 / 0.075 | **0.131 / 0.193 / 0.165** | +60% ✓ |

  **EX family (n=4,997):**

  | segment | n | raw | reranked | ΔR@10 |
  |---|---:|---|---|---:|
  | blended | 4997 | 0.871 / 0.958 / 0.878 | **0.927 / 0.967 / 0.912** | +1% ✓ |
  | era:pre1970 | 1112 | 0.862 / 0.963 / 0.894 | **0.920 / 0.970 / 0.926** | +1% ✓ |
  | era:1970-1999 | 2368 | 0.891 / 0.962 / 0.885 | **0.935 / 0.969 / 0.911** | +1% ✓ |
  | era:2000+ | 1517 | 0.844 / 0.949 / 0.855 | **0.918 / 0.961 / 0.901** | +1% ✓ |
  | richness:has-abstract | 448 | 0.578 / 0.862 / 0.689 | **0.813 / 0.897 / 0.826** | +4% ✓ |
  | richness:title-only | 4549 | 0.899 / 0.968 / 0.896 | **0.938 / 0.974 / 0.920** | +1% ✓ |
  | reftype:journal | 4665 | 0.875 / 0.962 / 0.887 | **0.931 / 0.970 / 0.920** | +1% ✓ |
  | reftype:other | 332 | 0.801 / 0.904 / 0.753 | **0.861 / 0.916 / 0.797** | +1% ✓ |

  **Gate 2 verdict: GREEN, unambiguously.** Reranked ≥ raw on Recall@10 AND
  nDCG@10 in **every single segment, both families** (16/16 rows ✓, script's
  own gate boolean: `true`). Blended KW nDCG@10 relative gain: **+76%**, far
  past the ≥10% bar (44b's rule). EX was already dense bge-m3's strength
  (R@10 .958 raw) and the reranker still improves it further everywhere,
  including the hardest EX segment (`richness:has-abstract`, R@1 .578→.813,
  +41% relative on R@1). KW — the segment LANE-EVAL's own REPORT flagged as
  needing supervision most (title-only R@1 .05 vs FTS's .16) — gets the
  largest relative gains (title-only ΔR@10 +52%, pre1970 +67%), directly
  answering the Stage-2 justification LANE-EVAL wrote down. **This result
  achieved with only 1 epoch** (the un-flagged deviation above) — the
  pinned 2-epoch config was never actually tested; a second epoch is a
  reasonable follow-up but not needed to clear Gate 2.

- **Latency**: GPU (L40S) — Phase 2's own steady-state throughput (~10.2
  q/s, each query = one batched forward pass over 50 candidates) gives
  **≈98 ms/query** end-to-end (DB round-trip for the candidate pool +
  cross-encoder inference) on the training box. **CPU (t4g-class,
  `bench_cpu.py`) — NOT measured.** The brief's Phase 2 asks for both,
  "latency per query on the L40S and per-query on CPU... the serving
  decision needs both" — running `44b/scripts/reranker/bench_cpu.py`-style
  CPU latency needs its own box, and the lead's explicit instruction this
  cycle was "do not launch another box." Left as an **open item for the
  lead** rather than launched unilaterally; the GPU number alone is enough
  to confirm Gate 2, just not enough to pick a serving tier.

- **Status: LANE-RERANK Gate 2 GREEN, ship-worthy per the brief's own rule.**
  Phase 0/1/2 all complete. Remaining open items, none blocking the gate
  verdict: (a) 1-epoch vs pinned 2-epoch (flagged, not re-run, per "do not
  launch another box"); (b) CPU latency unmeasured (flagged, same reason);
  (c) `~/Model/nsr-reranker/` sync — weights are in S3 only so far, not
  pulled to the 8 GB laptop (matches [[device-constraints]] and how the
  rehearsal checkpoint was also left S3-only); non-negotiable #7 says "sync
  to `~/Model/nsr-reranker/`" — deferred, a large pull (598 MB) the lead may
  want to do selectively rather than automatically.

- **Final spend, all runs, all settled:**
  - Phase 0 (rehearsal, 2 attempts): $0.19.
  - Failed real-training run (`20260817-021258-train`, IAM-gap incident,
    all compute completed but lost to the upload bug): $1.83.
  - My duplicate relaunch (`20260817-032837-train`, terminated early by the
    lead once the race was caught): ≈$0.09 (~2-3 min life).
  - Authoritative real-training run (`20260817-032126-train`, the one that
    counts): $1.25 (40.2 min).
  - **Total: ≈$3.36 of the $5.00 lane cap (67%).** The IAM-gap incident
    (avoidable) accounts for more than half of total spend — the one real
    inefficiency this lane produced, root-caused and fixed above.

- **Artifacts**:
  - `s3://nsr-embed-v2/reranker/train.py` (unchanged copy of 44b's file),
    `s3://nsr-embed-v2/reranker/train.sh`.
  - `s3://nsr-embed-v2/reranker/train/rehearsal/train-groups.jsonl` (994
    lines, 2,378,913 bytes).
  - `s3://nsr-embed-v2/models/nsr-reranker-gte-modernbert/
    20260817-011223-rehearse/final/` — rehearsal-only checkpoint (598,436,708
    byte `model.safetensors` + config/tokenizer), synced from the box; **not
    ~/Model** yet (rehearsal checkpoints aren't the deliverable, not pulled
    to the laptop — 8 GB Air, per [[device-constraints]]).
  - `s3://nsr-embed-v2/logs/nsr-reranker-20260817-011040-rehearse.log`
    (attempt 1, 5,444 bytes), `s3://nsr-embed-v2/logs/
    nsr-reranker-20260817-011223-rehearse{,-inner}.log` (attempt 2, 129,273 +
    1,391 bytes) — all three grepped for `postgresql://`: 0 hits.

- **Spend**: projected (pre-launch, from 44b's precedent arithmetic, not a
  measurement) ≈ $0.21 for the rehearsal (994 groups / 9.67 groups/s
  precedent + ~5 min boot), watchdog ceiling $1.40 (45 min cap) worst case.
  **Actual**: attempt 1 ≈2 min ≈$0.06, attempt 2 ≈4.3 min ≈$0.13 —
  **≈$0.19 total for Phase 0**, in line with projection. Full-run Phase 1
  projection (2 epochs, measured 26.4 groups/s): ≈$2.46 — see Gate 0 above.
  Well under the lane's $5.00 hard cap either way.

- **Deviations / flags**:
  1. **Non-negotiable #1's "torch/CUDA/python preinstalled" claim about the
     PyTorch DLAMI is wrong** — confirmed by attempt 1's failure, and
     independently by LANE-TRAIN's own REPORT for the same AMI. `python3` is
     present (unlike the base DLAMI's earlier `python`-not-found bug
     LANE-TRAIN also hit), but `torch` is not a host package; installing it
     costs a genuine ~2GB download every boot.
  2. `pairs-to-groups.mjs` held-out source changed from `${IN}/val.jsonl`+
     `test.jsonl` to `--heldout qrels.tsv` for the rehearsal (documented
     above and in the file's own header) — a necessity, not a preference,
     since LANE-TRIPLETS' rehearsal ships no val/test split. Real Phase 1
     should use LANE-TRIPLETS' own split as the primary source (script
     already supports unioning both).
  3. **Gate 0 is RED on wall-clock** (75.8 min train.py + ~3.4 min boot ≈ 79
     min vs ≤45 min target), **GREEN on spend** (~$2.46 vs $5 cap) — flagged
     above for the lead's decision, not acted on. Moot until Phase 1's data
     exists.
  4. `launch.sh`'s first draft didn't thread `EPOCHS`/`MAXHOURS` into the
     instance user-data (fixed before any run depended on a non-default
     value — see Phase 0 files above).
  5. 6 of LANE-TRIPLETS' 1,000 rehearsal anchors had a held-out paper as
     their own positive (caught and dropped by this lane's held-out guard,
     not LANE-TRIPLETS' own pipeline) — flagged for LANE-TRIPLETS, not fixed
     here (not this lane's file to edit).

---

# CSHL / RxivGPT — cshl-RR (the T3 that never ran)

*Everything above this line is the **NSR** project's reranker lane (bucket
`nsr-embed-v2`, benchmark `nsr-eval-v1`), kept for provenance. Below is CSHL.*

Append-only, UTC. Fence: no `api/`, no HF, no `scripts/train`, no `scripts/eval`
registry, no other lane's tables/boxes. Cap: **$5.00 AWS**. Laptop: nothing heavy.

## 2026-08-20T02:3xZ — inventory BEFORE building or launching anything

Read first, in this order: `docs/CSHL-CPT-REPORT.md`, `scripts/rerank-nsr/*`
headers, `data/reranker/`, `docs/prompts/LANE-RIG-PORT.md` (the T3 row),
`docs/HANDOFF-2026-08-19.md`, `LANE-QPAIRS-RUN.md`, `LANE-SHIP.md`.

**The brief's premise — "the rig and training groups were built last night" — is
half right. The rig was ported; the groups do not exist.** Measured, not assumed:

```
data/reranker/                        EMPTY  (created 08-19 01:42, never written)
aws s3 ls s3://cshl-embed-rxiv/reranker/   -> 0 objects (no train.py, no train.sh, no groups)
aws s3 ls s3://cshl-embed-rxiv/models/     -> cshl-encoder-bge-m3/ only
find . -name train.py                 -> nothing in repo
docs/HANDOFF-2026-08-19.md:17         "Reranker repo deliberately absent — T3 never ran."
```

`scripts/rerank-nsr/{launch.sh,train.sh,to-groups.mjs}` were re-headed for CSHL
at 08-19 19:03 (bucket `cshl-embed-rxiv`, role `cshl-embed`, param
`/cshl/embed/dburl`). That is the whole of what landed. Five gaps between that
and a run, each verified against the file rather than inferred:

**G1 — `to-groups.mjs` does not fit the miner output that exists.** It reads a
keys-only contract, `{anchor_key, positives:[key], negatives:[key], query,
source}`, from `data/mine/triplets.jsonl`. That path **does not exist**. What the
miner actually wrote is the nested slug shape:

```
data/mine/cshl-query-pairs.train.jsonl   424,753 lines   (val 52,962 · test 53,928)
  {query:"Mutations; Child Mental Disorders; snRNA",
   positive:{slug:"2024.04.07.24305438"},
   negatives:[{slug,source:"mesh-tree-sibling"|"same-category"} ×8],
   meta:{family:"MESH"|"AUTHORKW", category, pmid, n_terms, uis}}
data/mine/cshl-triplets.train.jsonl      132,793 lines   (query is an object — doc→doc, not our eval's shape)
```

Family mix over the first 60k rows: MESH 37,070 / AUTHORKW 22,930 — the same two
families the frozen benchmark uses (MESH 1,241 / AUTHORKW 759).

**G2 — the rerank launcher has no type failover.** The brief says "the merged
launcher supports type failover." It does — but that is
`scripts/train/launch.sh:32,139,149,231` (`TYPE_MENU`, walked type-by-type across
every AZ), which is the **encoder** launcher and inside this lane's fence.
`scripts/rerank-nsr/launch.sh:22` is still `TYPE=${TYPE:-g6e.xlarge}` — one type,
one shot, `run-instances` or bust. The rig merge never reached this file.

**G3 — `SAVE_STEPS` does not exist in the rerank rig, and checkpoints never leave
the box.** `scripts/train/launch.sh:129` exports
`SAVE_STEPS/SAVE_TOTAL_LIMIT/CKPT_SYNC_INTERVAL`; `rerank-nsr/launch.sh` and
`train.sh` export none. 44b's `train.py` *does* checkpoint —
`--ckpt-steps` (default **2000**), `--resume`, and a wall-clock kill that
checkpoints on the way out (`train.py:38,40,184,187,243-247`) — but `train.sh:45`
passes only `--dir --base --epochs --bulk --max-hours`, so the default 2000 stands,
and **nothing syncs `checkpoint/` to S3 during the run.** On an
`instance-initiated-shutdown-behavior terminate` box, a checkpoint on local EBS
is not a checkpoint. As it stands a kill at minute 44 loses 44 minutes, not ≤10.

**G4 — `cshl-QP2` and `docs/prompts/LANE-WIN.md` do not exist.** `grep -rn
"QP2\|LANE-WIN\|win-lane\|qp2" docs/ scripts/` returns **zero hits**. The winning
arm is **`cshl-QP`** (`preprint_embeddings_cshl_qp`, 433,449 rows, HNSW
`idx_pp_emb_cshl_qp_hnsw` valid), produced by `LANE-QPAIRS-RUN.md`, which is
**already final** — spend ledger closed at ≈$2.95, all boxes self-terminated.
There is nothing to wait for and nothing to poll. Taking the brief's own
authorised fallback and scoring on **cshl-QP**.

**G5 — the scoring path is NSR-shaped.** `scripts/eval/score-rerank.mjs` hardcodes
`data/eval/nsr-eval-v1` and segments `era/richness/reftype`; CSHL's benchmark
segments are `server/era/published/abstract`. It also consumes a
`{qid, family, raw_top50, reranked_top50}` file that nothing currently produces.
And `cshl_qp.perquery.json` carries **`{arm,version,keys,family,hits10}` only —
no candidate lists**, so the top-50 to rerank must be regenerated from
`qemb/cshl_qp.jsonl` + the corpus table. `scripts/eval/paired-test.mjs` (McNemar +
bootstrap over `perquery.json`) is CSHL-shaped already and needs nothing.

## Holdout discipline — the one thing that was already right, proven not asserted

`to-groups.mjs` guards with `md5("holdout:"+key)[0:8]/0xffffffff < 0.25` and
audits what it **EMITS** (`bleed` check, exits 1 and writes nothing on any hit).
That rule is only worth anything if the frozen benchmark's papers actually fall
inside it, so I checked rather than trusted:

```
data/eval/cshl-eval-2k/qrels.tsv   2,000 rows · 1,839 distinct gold keys
   md5 rule marks held out: 1,839 / 1,839  = 100.0%   trainable leak: 0
data/eval/cshl-eval-v1/qrels.tsv  10,000 rows · 6,203 distinct gold keys
   md5 rule marks held out: 6,203 / 6,203  = 100.0%   trainable leak: 0
```

**Gate PASS.** Every gold paper in both benchmarks is on the held-out side of the
same hash the converter uses, so anything the converter emits is disjoint from
the benchmark by construction — and the emit-side bleed check proves it per run
rather than restating it. (Note the qrels here are **2-column** `qid\tkey`, not
NSR's 3-column; `pairs-to-groups.mjs`'s "col 2 = key_number" comment is an NSR
fact and does not transfer.)

**Nothing launched. $0.00 spent so far.**

## 2026-08-20T02:29–02:34Z — built what the brief assumed existed

**Groups.** `scripts/rerank-nsr/qpairs-to-contract.mjs` (new, this lane): an
**adapter**, not a second converter — it maps LANE-MINE's nested slug shape onto
the keys-only contract `to-groups.mjs` already reads, and carries no holdout
logic, no text and no policy of its own beyond a deterministic take-first-N. The
held-out rule and the emit-side bleed proof stay in exactly one file.

```
qpairs-to-contract.mjs  N=40000  ->  data/mine/rerank-input.jsonl (12.2 MB)
   dropped: no-query 0 · no-positive 0 · no-negatives 0
   family mix MESH 24,539 (61.3%) · AUTHORKW 15,461 (38.7%)   [benchmark: 62/38 — matched]
to-groups.mjs  NAME=parity  ->  data/reranker/parity/train-groups.jsonl
   40,000 groups · 252,736,569 bytes · md5 ebbbf50e46c20e0fd14a3d1c0c6b4935
   resolved 221,125/221,125 keys · dropped held-out 0 · dropped empty-negatives 0
   holdout bleed into emitted groups: 0 (must be 0)   <- GATE PASS
```

**"dropped held-out 0" is not the guard sleeping — I checked, because a guard
that never fires and a guard that is broken look identical from the outside.**
Measured across the miner's own splits:

```
             positives held out        negatives held out
train        0 / 60,000   (0.0%)       120,224 / 480,000  (25.0%)
val          0 / 52,962   (0.0%)       106,253 / 423,696  (25.1%)
test         0 / 53,928   (0.0%)       107,508 / 431,424  (24.9%)
```

LANE-MINE already excluded held-out papers from ever being a **positive** — hence
zero record-level drops. It did **not** filter **negatives**, which sit at the
exact 25% base rate. So the guard fired hard and silently on the negative side:
mean negatives per emitted group is **5.90, not 7**, because ~25% of every
record's negatives were held-out benchmark papers. That is the "not as a
positive and **not as some other query's negative**" half of the rule doing the
only work there was to do — roughly 86k held-out paper appearances kept off the
GPU in this slice alone. Sized to 40k (not the 56k first built) to match T3's
approved shape and keep retry headroom under the $5 cap.

## 2026-08-20T02:34–02:36Z — three more gaps closed before spending anything

**G2 fixed** — `TYPE_MENU` + the type/AZ walk ported into
`scripts/rerank-nsr/launch.sh` from `scripts/train/launch.sh` (read, not edited —
it is fenced). The `|| true` on the `OUT=$(launch_in …)` assignment is carried
over deliberately: under `set -e` a capacity error inside a command substitution
in an assignment kills the whole script, so the retry loop can never reach its
second iteration without it.

**G3 fixed** — `--ckpt-steps` is now passed explicitly (**1000**, ≈4.4 min at the
expected ~3.75 steps/s, vs train.py's default 2000 ≈ 8.9 min), and a background
loop mirrors `model/checkpoint/` to S3 every **240 s**. Worst-case loss ≈ **8.4
min ≤ 10**. The mirror is ordered against train.py's own save semantics
(`train.py:205-212` writes weights first, `state.json` last): it copies
everything *except* `state.json`, re-reads the local step, and commits the marker
only if the step did not move mid-copy — otherwise a save landing during the
sync would publish half a model under a marker claiming it whole. Caveat
recorded: train.py saves weights + epoch/step but **not optimizer state**, so a
resume restarts AdamW cold. That is 44b's design; train.py runs unchanged.

**G6 — the launch-blocker, caught by audit rather than by a dead box.** Before
launching I read the role instead of trusting it. `cshl-embed`'s four inline
policies grant `s3:PutObject` on exactly `cshl-embed-rxiv/logs/*` and
`cshl-embed-rxiv/eval/*`. **`models/*` was not writable.** `train.sh` uploads the
weights to `models/cshl-reranker-gte-modernbert/$RUN_ID/final/` under `set -e`
with no `|| true` (deliberately — weights first, everything after best-effort),
so the run would have completed every GPU-minute of training and then died on
AccessDenied with the model on a delete-on-termination volume. **That is the NSR
lane's $1.83 incident and the qpairs lane's `qemb` incident, exactly.** Fixed
with a new inline policy under its own name, `write-model-artifacts`
(PutObject/AbortMultipartUpload/DeleteObject on `models/*`) — a *separate* name on
purpose, because `scripts/train/launch.sh` re-puts `read-dburl` on every launch
and `put-role-policy` replaces by name, which is how the qpairs lane lost a grant
it had verified ten minutes earlier. Proven, not assumed:

```
simulate-principal-policy  role/cshl-embed  on models/cshl-reranker-.../final/model.safetensors
  s3:PutObject     allowed
  s3:DeleteObject  allowed
```

**G7 — credential removed from the box.** `train.sh`'s §5 claims "no DB
credential reaches this box", but `launch.sh`'s user-data still fetched
`/cshl/embed/dburl` and exported `DATABASE_URL` into it. `grep` finds **zero**
references to `DATABASE_URL` in `train.sh` — the scoring step that needed it was
removed during the port. Dropped from the user-data, so the header is now true.

## 2026-08-20T02:36Z — LAUNCHED

```
run_id 20260819-223601-train   instance i-094b84dd57595f795   g6e.2xlarge   $2.24208/hr
TYPE_MENU=g6e.2xlarge,g5.2xlarge  EPOCHS=2  MAXHOURS=1.1  WATCHDOG_MIN=150
CKPT_STEPS=1000  CKPT_SYNC_INTERVAL=240  TRAIN_NAME=parity (40,000 groups)
base Alibaba-NLP/gte-reranker-modernbert-base   --bulk 0

type g6e.2xlarge: no capacity in subnet-0200d8f947fcf9090 — next AZ
type g6e.2xlarge: no capacity in subnet-0407bd1ff7e9d8c44 — next AZ
type g6e.2xlarge: no capacity in subnet-09e840612db030382 — next AZ
launched: i-094b84dd57595f795 (g6e.2xlarge, subnet-06b1914b54fc3e0c5)
```

**G2 paid for itself on the first launch.** Three of four AZs refused
`g6e.2xlarge` outright. The unpatched launcher was a single `run-instances`
against one AZ — it would have exited non-zero before the fourth subnet was ever
tried, and the honest reading of that failure would have been "g6e has no
capacity tonight", which was false.

Budget guard: $2.24208/hr means the $5.00 cap is **133 min** of box life, and the
watchdog is 150. The watchdog is the backstop against *me* dying, not the primary
control — I hold the turn and terminate at the cap if the run has not finished.

## 2026-08-20T02:37–02:43Z — Phase 3 path built while the GPU trains

Training is a 50-minute wait; the scoring path did not exist yet (G5), so it was
built during the wait rather than after it.

**`scripts/rerank-nsr/dump-candidates.mjs` (new)** — freezes an encoder arm's
top-50 lists *and* the candidate text, so the scoring box needs no database
credential and raw-vs-reranked is a paired comparison over the identical list.
It re-uses `score.mjs`'s own registry (`import { REGISTRY, OPS }`) so the
operator, `ef_search` and `TOPK` cannot drift from the encoder rows this will be
compared against — a reranker measured over a differently-retrieved pool is not
measuring reranking. `DOC_CHARS=900` matches the training converter *and*
`api/_lib/embed.ts`'s serving slice: same text budget in training, scoring and
serving, or the number does not transfer.

```
cshl_qp: 2000 queries, 2000 query vectors, table preprint_embeddings_cshl_qp, cosine <=>
  plan: Index Scan CONFIRMED
  -> cshl_qp.lists.json (2,034,871 B) · docs.jsonl 81,751/81,751 documents resolved (76.4 MB)
```

**The lists were checked against the published run before being used for
anything.** A regenerated pool that quietly differs from the scored one would
make every "before" number a near-miss of the real encoder row and every delta
slightly wrong, in a way no downstream check would catch:

```
                     mine       published (results/cshl_qp.json)
AUTHORKW  n=759      —          759
  r1      0.5336     0.5336     MATCH
  r10     0.7497     0.7497     MATCH
  r50     0.8208     0.8208     MATCH
  mrr     0.6079     0.6079     MATCH
  ndcg10  0.6395     0.6395     MATCH
MESH      n=1241     —          1241
  r1      0.2224     0.2224     MATCH
  r10     0.4319     0.4319     MATCH      <- the qpairs headline, reproduced
  r50     0.6076     0.6076     MATCH
  mrr     0.2921     0.2921     MATCH
  ndcg10  0.3190     0.3190     MATCH
```

**Exact on all ten, both families.** The "before" row is therefore the published
encoder row itself, not a re-run approximation of it.

**`scripts/rerank-nsr/rerank.py` (new)** — cross-encoder over the frozen pool.
Ties break on the original rank, so a model that scores everything identically
reproduces the raw list exactly instead of shuffling it into a fake delta.

**`scripts/rerank-nsr/score-rerank-cshl.mjs` (new)** — the CSHL twin of
`scripts/eval/score-rerank.mjs` (which is NSR-shaped: `nsr-eval-v1`, segments
`era/richness/reftype`). Left LANE-EVAL's file alone — it is still correct for
NSR and is not this lane's. `era` and `lenBand` are *imported* from `score.mjs`
so segment definitions cannot drift. Metrics are a byte-copy of
`score.mjs:metricsFor`. It refuses outright if the reranked list is not a
permutation of the raw one, and writes `paired-test.mjs`-shaped perquery files
for **both** sides so McNemar runs on the same contract every other arm uses.

**`scripts/rerank-nsr/score-launch.sh` (new)** — Phase 3 box. Separate from
`launch.sh` deliberately: the training box self-terminates the instant train.sh
returns, so there is no window to reuse it, and folding scoring into train.sh
would put Phase 3's correctness behind a 50-minute training run every time it
changes. Carries no DB credential and no training data. Preflights the weights,
lists and docs on the laptop before booting anything.

### A property of this run, recorded rather than discovered later

`train.py:225-227` pads short negative lists **by repetition**
(`while len(negs) < A.negatives: negs.append(negs[-1])`). Our groups average
**5.90** negatives, not 7, because the held-out guard removed ~25% of them — so
roughly 1.1 negatives per group are duplicates, slightly over-weighting one
negative in the 8-way softmax. It is train.py's documented behaviour and train.py
runs unchanged (non-negotiable #2), so it was not touched. **The better fix is
upstream and belongs to a future run:** the converter should backfill negatives
from the non-held-out pool to restore a full 7, rather than letting the guard
thin them. Flagged, not silently absorbed.

### Run state

```
02:36:24Z  i-094b84dd57595f795  g6e.2xlarge  running
[  19.7s] training: 10000 steps (5000/epoch), group=8, batch=64 pairs
[  49.5s] epoch 0 step 100/5000 loss 0.3193
[train.sh] ckpt-sync started (pid 2284, every 240s -> .../20260819-223601-train/checkpoint/)
```

Measured **~3.33 steps/s** → 10,000 steps ≈ **50 min**, inside `MAXHOURS=1.1`
(66 min), so both epochs fit. `CKPT_STEPS=1000` ≈ 5.0 min at this rate; with the
240 s mirror, worst-case loss ≈ **9 min ≤ 10** — G3's target holds at the
measured rate, not just the projected one.

## 2026-08-20T02:46Z — G3 proven in flight, not asserted

The checkpoint mirror is my own fix, so it does not count until it is observed
working on a live box:

```
box 02:43:02Z  train.py save('checkpoint', epoch 0, step 1000)  -> local EBS
S3 02:46:32Z   config.json 1.9 KiB · model.safetensors 570.7 MiB · tokenizer* 3.4 MiB
S3 02:46:35Z   state.json 281 B          <- marker committed 3 s AFTER the weights
```

The ordering is the whole point and it held: everything except `state.json`
first, the marker last, so S3 never carries a completion marker over weights
that are still uploading. **Measured worst-case loss** = 4.4 min (1000 steps at
3.8 steps/s) + 3.5 min (save→commit lag) ≈ **8 min ≤ 10**, the brief's bar, from
a measurement rather than a projection. A kill at any point from here loses at
most that, and `RESUME=1` on a relaunch pulls this prefix back down.

Self-test of the scorer while waiting: fed `score-rerank-cshl.mjs` an **identity**
rerank (reranked == raw). Both sides came back byte-identical to the published
`cshl_qp` row in every segment of both families (AUTHORKW 0.5336/0.7497/0.6395,
MESH 0.2224/0.4319/0.3190), and the permutation guard passed 0/2000. So a null
result will read as null rather than as noise. Test artifacts deleted.

The encoder landscape this reranker has to move, from `results/*.json` (R@10):

| arm | AUTHORKW | MESH | note |
|---|---:|---:|---|
| fts | 0.2398 | 0.0806 | lexical floor |
| bge-m3 | 0.6522 | 0.2861 | stock |
| cshl | 0.6693 | 0.3320 | triplets fine-tune |
| **cshl_qp** | **0.7497** | **0.4319** | qpairs fine-tune — tonight's base |
| medcpt | 0.8076 | 0.4569 | in-domain baseline |
| *cshl_qp R@50* | *0.8208* | *0.6076* | **the reranker's ceiling** |

The ceiling matters: a perfect reranker over cshl_qp's own top-50 tops out at its
R@50, which is **above** MedCPT's encoder R@10 in both families. So there is real
headroom — and any claim that lands above 0.8208/0.6076 would be a bug, not a win.

## 2026-08-20T03:21Z — training complete, clean

```
[ 1279.8s] epoch 1 done -> /opt/reranker/run/model/epoch-1
[ 2536.7s] epoch 2 done -> /opt/reranker/run/model/epoch-2
[ 2537.4s] done -> /opt/reranker/run/model/final
[train.sh] train.py EXIT=0 wall-clock=2539s
[train.sh] model saved+loaded OK from .../final, sanity logit=-3.8807
[train.sh] done. weights: s3://.../models/cshl-reranker-gte-modernbert/20260819-223601-train/final/
```

Loss trajectory: epoch 0 `0.3193 -> ~0.15`, epoch 1 settled at **~0.05**. Both
epochs ran in full — the `MAXHOURS=1.1` wall-clock kill never fired (2,539 s =
42.3 min against a 66 min budget).

**The two fixes were load-bearing, and the logs prove it rather than my say-so:**

```
grep -c AccessDenied      outer log -> 0      (G6: models/* was NOT writable before tonight)
grep -c postgresql://     outer + inner -> 0  (G7: credential no longer shipped)
grep -c neon.tech         outer + inner -> 0
```

Artifacts, all four prefixes present under `models/cshl-reranker-gte-modernbert/20260819-223601-train/`:
`final/` · `epoch-1/` · `epoch-2/` · `checkpoint/` — each 570.7 MiB
`model.safetensors` + config/tokenizer/state.

### G8 — `train.sh`'s own throughput line was lying, by exactly a factor of EPOCHS

It reported `1.978 steps/s -> 15.82 groups/s` and projected **126.4 min** for a
60k×2 run. The real rate was **3.94 steps/s / 31.5 groups/s** (10,000 steps in
2,539 s). The parser took the first and last `step N/…` log lines and divided by
elapsed time — but train.py **resets `step` to 0 at every epoch boundary**, so it
divided ONE epoch's step count by ALL epochs' wall-clock. The error is exactly
`EPOCHS`; measured ratio **1.99x**.

This is the kind of number that gets copied into a planning table and quietly
doubles every future estimate — the NSR lane's `26.4 groups/s` precedent, which
this lane's own projections were built on, was produced by this same parser and
should be re-derived before it is trusted again. Fixed to accumulate
`epoch * steps_per_epoch + step`; re-run against the real log it now reports
**3.996 steps/s -> 31.97 groups/s, projection 62.6 min** instead of 126.4.

**Spend so far:** training box `i-094b84dd57595f795`, g6e.2xlarge @ $2.24208/hr,
02:36:24Z → ~03:21:30Z = **45.1 min ≈ $1.685**.

## 2026-08-20T03:21–03:31Z — Phase 3 attempt 1: I repeated the bug I had just fixed

Scoring box `i-05ed0e70ed7e9448a` (g5.xlarge, A10G). The reranking itself was
flawless:

```
[   0.3s] device=cuda NVIDIA A10G
[   2.0s] model loaded
[ 307.0s] 2000/2000 queries · 100000 pairs · 326 pairs/s
[ 307.1s] wrote 2000 rows -> /opt/rr/reranked-20260819-232122-score.json
[ 307.1s] rerank latency per query over 50 candidates: p50 150.8 ms · p95 162.6 ms
```

Then:

```
upload failed: ... to s3://cshl-embed-rxiv/reranker/scored/cshl-eval-2k/reranked-....json
  An error occurred (AccessDenied) when calling the PutObject operation:
  User: .../cshl-embed/i-05ed0e70ed7e9448a is not authorized to perform: s3:PutObject
  on "arn:aws:s3:::cshl-embed-rxiv/reranker/scored/..." because no identity-based
  policy allows the s3:PutObject action
+ echo SCORE-EXIT=0
SCORE-EXIT=0
```

**This is G6 again, and I am the one who reintroduced it.** Two hours earlier I
audited the role, found `models/*` unwritable, granted exactly `models/*`, and
proved it with `simulate-principal-policy`. Then I wrote a new script that
writes to `reranker/scored/*` — a prefix I had never checked — and launched it
without re-running the audit against *its* write path. The grant I added was
correct and narrow; my mistake was treating "I audited the IAM" as a property of
the lane rather than of one specific path. **Cost: ~8 min of g5.xlarge ≈ $0.13,
and the whole rerank had to be recomputed.** Nothing was lost but time and $0.13,
because the failure was loud in the log even though the exit code lied.

Two fixes, both applied before relaunching:

1. **The grant**, extended to `reranker/*`, then simulated **per resource
   individually** rather than in one collapsed call (the batched form returned a
   single `${BucketName}/${KeyName} allowed` row that told me nothing):
   `reranker/scored/…` allowed · `logs/…` allowed · `models/…/final/…` allowed ·
   `reranker/eval/…` allowed · GetObject on the weights allowed.
2. **`SCORE-EXIT=0` on a failed upload.** The box reranked 100,000 pairs, lost
   the file, and reported success — the identical shape LANE-SHIP found in the
   publish rig this same night (`PUBLISH-DONE` printed unconditionally after a
   failed push). The upload's exit code is now the run's exit code, and the box
   `head-object`s the result back and prints `UPLOAD-VERIFIED` before shutting
   down. An upload that dies looks complete from the process side unless you make
   it not.

**Attempt 2 launched: `i-0e127cdcccce9f9d0` (g5.xlarge), run 20260819-233100-score.**

Measured, useful regardless: the cross-encoder does **326 pairs/s on an A10G**,
**p50 150.8 ms / p95 162.6 ms per query over 50 candidates** at batch 256. That
is the serving-tier number the NSR lane left open — on GPU. CPU remains unmeasured.

## 2026-08-20T03:39Z — THE RESULT

Attempt 2 (`i-0e127cdcccce9f9d0`) landed `reranked-20260819-233100-score.json`, 2000 rows,
3.8 MiB. Permutation guard: **0/2000** rows where the reranked list was not a permutation of
the raw one. Raw-side perquery reproduced the published `cshl_qp` hits exactly (**0**
differences), so the "before" column is the published encoder row, not a re-derivation of it.

### Raw `cshl_qp` top-50 vs `+cshl-RR` — blended, both families

| family | R@1 | R@10 | nDCG@10 |
|---|---|---|---|
| MESH (1,241) | 0.2224 → **0.3022** (+36%) | 0.4319 → **0.5238** (+21%) | 0.3190 → **0.4075** (+28%) |
| AUTHORKW (759) | 0.5336 → **0.5771** (+8%) | 0.7497 → **0.7668** (+2%) | 0.6395 → **0.6746** (+5%) |

**19 of 20 segments improve on both R@10 and nDCG@10.** The strict gate boolean is
**`false`**, and the reason is one query: AUTHORKW `server:medrxiv` (n=135) went
0.7037 → 0.6963 on R@10 — **95 hits to 94** — while its nDCG@10 rose +5%. Reported as a
`false` gate rather than rounded away, because the gate is a bar and 94 < 95.

MESH is where the money is, which is the outcome the whole program pointed at: it is the
family this project has lost on since the first benchmark, and it is the one the cross-encoder
lifts most (R@1 +36%). AUTHORKW was already dense retrieval's strength.

### Paired tests (`scripts/eval/paired-test.mjs`, exact McNemar + seeded bootstrap, n=2,000)

| comparison | R@10 | Δ | p | 95% CI | won / lost |
|---|---|---:|---:|---|---|
| +cshl-RR vs its own un-reranked top-50 | 0.6160 / 0.5525 | +0.0635 | **6.4e-17** | [+0.049, +0.079] | 183 / 56 |
| +cshl-RR vs MedCPT **encoder** | 0.6160 / 0.5900 | +0.0260 | **0.0119** | [+0.006, +0.046] | 232 / 180 |
| cshl_qp encoder vs MedCPT encoder *(reference, unchanged)* | 0.5525 / 0.5900 | −0.0375 | 0.0003 | [−0.058, −0.018] | 171 / 246 |

**The labelling, stated plainly and carried into the report:** `cshl-QP + cshl-RR` is a
**SYSTEM** — two models and ~150 ms of extra GPU per query. MedCPT's row is **one encoder**.
The system wins that comparison significantly; **our encoder still loses to their encoder,
significantly, and nothing tonight changed that row.** The third line above is in the table
precisely so the second cannot be quoted alone.

**MedCPT publishes `ncbi/MedCPT-Cross-Encoder`.** System-vs-system was **not** run and is not
claimed — filed as follow-up #7 in the report, with the note that the rig to do it already
exists (`dump-candidates.mjs` freezes any arm's pool; `rerank.py` scores any cross-encoder
over it).

Ceiling check: `cshl_qp` R@50 is 0.8208 / 0.6076, so the reranked 0.7668 / 0.5238 sits inside
what the pool can support — 64% of the available MESH headroom taken, 10% of AUTHORKW's.

### Serving cost, measured

**326 pairs/s on an A10G · p50 150.8 ms / p95 162.6 ms per query over 50 candidates**
(batch 256). This closes the GPU half of the item the NSR lane left open. **CPU is still
unmeasured** — it needs its own box and was not worth one tonight; a serving-tier decision
still cannot be made from this alone.

## Spend ledger — measured lifetimes, published rates

| box | type | rate | window (UTC) | min | $ |
|---|---|---|---|---:|---:|
| `i-094b84dd57595f795` train | g6e.2xlarge | $2.24208/h | 02:36:24 → ~03:22 | 45.6 | **1.70** |
| `i-05ed0e70ed7e9448a` score (lost) | g5.xlarge | $1.006/h | 03:21:30 → ~03:30 | 8.5 | **0.14** |
| `i-0e127cdcccce9f9d0` score | g5.xlarge | $1.006/h | 03:31:08 → ~03:39 | 8.5 | **0.14** |
| S3 | — | — | ~2.5 GB transient + requests | — | ~0.05 |
| | | | | | **≈ 2.04** |

**≈$2.04 of the $5.00 hard cap (41%), $2.96 unspent.** All three boxes self-terminated; none
was left idle. Local work (40k-group conversion, candidate dump, all scoring) ran on the
laptop but was I/O against Neon and S3, never model compute — the house rule held.

**Waste, itemised, mine:**

| item | $ | what happened |
|---|---:|---|
| lost scoring pass | **0.14** | 100,000 pairs reranked correctly, then `AccessDenied` on a prefix I had not audited. Entirely my error — see 03:31Z. |

**Boxes running at close that are NOT mine** (recorded so this ledger is not later charged
with them): `i-0efe2e00b91aedceb` g6e.2xlarge `cshl-train-20260819-232838-train` (train lane),
`i-0521de00f1353300c` t3.small `cshl-publish-…` (ship lane), plus the two serve boxes and
`44b-web`. **Zero of my three boxes remain.**

## Status

**T3 has run.** `cshl-RR` exists, is scored, and the result is significant on both
comparisons that were asked for. Published: **nothing** — no HF push, per the brief.

Open, none blocking the result:
1. **MedCPT system-vs-system** — the comparison that would settle it (report follow-up #7).
2. **CPU latency** — unmeasured; needs its own box.
3. **Negatives thinned, not backfilled** — 5.90/group where train.py expects 7; it pads by
   repetition. Untested upside from a converter that backfills (follow-up #9).
4. **One regressed segment** — AUTHORKW `server:medrxiv`, one query. Not investigated; n=135.
5. **Weights are S3-only** — 570.7 MiB, not pulled to the 8 GB laptop, consistent with how
   every other checkpoint in this program has been left.

## 2026-08-20T03:42Z — re-checked cshl-QP2 at close (the brief's primary target)

My 02:30Z finding that `cshl-QP2` and `LANE-WIN.md` did not exist was true when written and
is now **stale** — the win lane started after my inventory. Current state, re-measured rather
than assumed:

```
docs/prompts/LANE-WIN.md                       exists (26,881 B, written 03:31Z)
scripts/eval/score.mjs:55  cshl_qp2            IS in the registry now
                           table preprint_embeddings_cshl_qp2, 1024-d, cosine
SELECT count(*) FROM preprint_embeddings_cshl_qp2   ->  0        (target 433,449)
data/eval/cshl-eval-2k/qemb/cshl_qp2.jsonl     absent
data/eval/cshl-eval-2k/results/cshl_qp2.*      absent
```

**QP2's Phase 2/3 has not finished** — the corpus re-embed has not started, so an HNSW build
and a scoring pass are still ahead of it, comfortably over an hour. That is exactly the "if
QP2 slips" case the brief authorised, so tonight's arm is **cshl-QP**, as reported. No message
was sent to that lane; this was read from their log and the database only.

**QP2 needs no new engineering from this lane.** The moment `qemb/cshl_qp2.jsonl` and the
populated table exist, the whole comparison is two commands against the rig already built and
proven tonight:

```sh
ARM=cshl_qp2 EVAL_VERSION=cshl-eval-2k node scripts/rerank-nsr/dump-candidates.mjs
MODEL_RUN=20260819-223601-train ARM=cshl_qp2 ./scripts/rerank-nsr/score-launch.sh
# then: IN=<pulled reranked.json> BASE=cshl_qp2 ARM=cshl_qp2+cshl_rr \
#         node scripts/rerank-nsr/score-rerank-cshl.mjs
# then: A=cshl_qp2+cshl_rr B=cshl_qp2 ... node scripts/eval/paired-test.mjs
```

`dump-candidates.mjs` appends only *new* candidate text to the shared `docs.jsonl`, so the
second arm costs a fraction of the first. Estimated **≈$0.15** and ~10 min of box time, well
inside the $2.96 left under the cap. **cshl-RR itself does not need retraining for QP2** — it
is a cross-encoder over (query, document) text and is independent of which encoder retrieved
the pool.

---

## 2026-08-20T03:45–04:14Z — follow-up #7, on the lead's instruction: SYSTEM vs SYSTEM

**Verdict up front: we lose it.** `cshl-QP`+`cshl-RR` 0.6160 vs `MedCPT`+`MedCPT-CE` 0.6510
blended R@10, **Δ −0.0350, exact McNemar p = 0.0002**. That is the deciding comparison and it
goes against us. Everything below is why, and what it points at.

### Fairness first, because a rigged win is worthless

MedCPT's card specifies `max_length=512`, `[[query, article]]` pairs, higher logit = more
relevant. Our `docs.jsonl` was cut to 900 chars to match `api/_lib/embed.ts`'s serving slice —
running MedCPT in that window would have handicapped it. Measured rather than assumed:

```
docs-900.jsonl    n=132,585  mean 895 chars   truncated at cap: 129,248 (97.5%)
docs-2000.jsonl   n= 81,578  mean 1,646 chars truncated at cap:  24,584 (30.1%)
```

**97.5% of documents were being truncated at 900.** So MedCPT got a purpose-built 2,000-char
document set and `max_len=512`; `cshl-RR` ran at 900/256, which is both what it was trained on
and what we actually serve. Ours measured as it ships, theirs measured at its published best.
The docs filename now carries the width (`docs-<N>.jsonl`) because two arms sharing one docs
file at different truncations would be an unfair comparison nothing downstream could detect.

**A trap caught before it cost anything:** `rerank.py` was passing `num_labels=1` to
`from_pretrained`. If a published checkpoint's head is a different size, `transformers`
**silently reinitialises the classifier with random weights** — the model loads, scores, and
reports a number that is not the published model's. It would have looked like a MedCPT
baseline and been noise. Now the model loads as published and the script *asserts*
`num_labels == 1` and that `--max-len` fits `max_position_embeddings`. Both confirmed live:
`MedCPT-Cross-Encoder num_labels=1 max_position_embeddings=512 using max_len=512`;
ours `num_labels=1 max_position_embeddings=8192 using max_len=256`.

Pools verified before use, same discipline as before — the regenerated `medcpt` top-50
reproduced the published `medcpt.json` on **all ten metrics, both families**, and the raw side
of the scorer matched `medcpt.perquery.json` with **0** differences. Permutation guard: 0/2000
on both cells. Per-path IAM simulated individually for all **8** paths before launch.

### The 2×2 — R@10 / nDCG@10

| system | AUTHORKW | MESH |
|---|---|---|
| `cshl_qp` | 0.7497 / 0.6395 | 0.4319 / 0.3190 |
| **`cshl_qp` + `cshl-RR`** | 0.7668 / 0.6746 | 0.5238 / 0.4075 |
| `medcpt` | 0.8076 / 0.6885 | 0.4569 / 0.3373 |
| **`medcpt` + `MedCPT-CE`** | **0.8577 / 0.7741** | 0.5246 / 0.4047 |
| `medcpt` + `cshl-RR` | 0.8235 / 0.7225 | **0.5439 / 0.4236** |

### Paired tests (`FAMILY=` slicing, added by the win lane tonight)

| comparison | scope | R@10 | Δ | p | CI |
|---|---|---|---:|---:|---|
| ours vs theirs (systems) | blended | 0.6160 / 0.6510 | **−0.0350** | **0.0002** | [−0.054, −0.016] |
| | MESH | 0.5238 / 0.5246 | −0.0008 | **1.0000** | [−0.025, +0.024] |
| | AUTHORKW | 0.7668 / 0.8577 | −0.0909 | 2.3e-11 | [−0.117, −0.065] |
| same pool: our RR vs their CE | blended | 0.6500 / 0.6510 | −0.0010 | **0.9312** | [−0.013, +0.010] |
| | MESH | 0.5439 / 0.5246 | **+0.0193** | **0.0127** | [+0.005, +0.034] |
| | AUTHORKW | 0.8235 / 0.8577 | −0.0343 | 0.0002 | [−0.053, −0.017] |
| their CE's own lift | blended | 0.6510 / 0.5900 | +0.0610 | 7.3e-18 | [+0.047, +0.075] |

### The finding that matters: the gap is the ENCODER, not the reranker

The cross cell was worth the extra five minutes of box time. **Handed MedCPT's own candidate
pool, our reranker and theirs are a statistical dead heat** (−0.0010, p = 0.93, CI ±0.01) —
and on **MeSH our reranker beats their cross-encoder outright** (+0.0193, p = 0.013). The
single best MeSH R@10 produced tonight by any configuration is **`medcpt` + `cshl-RR` =
0.5439**, above both complete systems.

Pool ceilings agree: R@50 is 0.8208 / 0.6076 for `cshl_qp` against 0.8920 / 0.6237 for
`medcpt`. **AUTHORKW retrieval is short by ~7 points of recall before a reranker sees
anything.** No further reranker training closes that; only a better encoder does.

**Two caveats, recorded because they cut opposite ways.** (a) `cshl-RR` is fine-tuned on this
domain on 40,000 in-domain groups; MedCPT's CE is **zero-shot** here — that our tuned model
only ties theirs overall is *worse* than the bare numbers look. (b) MedCPT trained on PubMed,
and much of this corpus is preprints of PubMed-indexed papers, so part of its AUTHORKW
advantage may be familiarity — which cuts in *their* favour and does not rescue our loss, but
does make the AUTHORKW gap an upper bound on their real modelling advantage.

### Run record

```
i-0ef6b4e758dcfc75b  g5.xlarge (A10G)  03:59:21Z -> ~04:13Z  ~14 min  $1.006/h  = $0.23
  CELL medcpt_medcptce  UPLOAD-VERIFIED bytes=4044286   p50 153.7 ms · p95 172.4 ms (512 tok)
  CELL medcpt_cshlrr    UPLOAD-VERIFIED bytes=4044286   p50 153.2 ms · p95 163.3 ms (256 tok)
  COMPARE-EXIT=0
```

Both cells uploaded and `head-object`-verified before shutdown — the fix from the 03:31Z
incident, working. **$0.23 against the $0.75 the lead authorised.** Lane total now
**≈$2.27 of $5.00.**

### QP2 — still not landed

`preprint_embeddings_cshl_qp2` is **0 / 433,449 rows** and `qemb/cshl_qp2.jsonl` is absent;
the win lane's own ledger still lists its re-embed as *projected*. The QP2 rerank the lead
asked for is **queued, not skipped** — it is three commands against the rig already proven
here, ≈$0.15, and `cshl-RR` needs no retraining for it (a cross-encoder scores (query,
document) text and is indifferent to which encoder built the pool).
