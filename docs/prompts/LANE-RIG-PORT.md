# LANE-RIG-PORT — port the NSR rigs (embed / serve / train / publish / eval) to CSHL (build-only, no launches)

**HARD CAPS: NO EC2/AWS launches, NO HF pushes, NO spend — rigs cost money and every launch needs Brendan's explicit go, per-launch, with a cost estimate in front of him. DB access: read-only against the CSHL database, except one smoke test (Task 5, ≤100 rows, cleaned up after). Verify the DB endpoint host is `ep-orange-water-aut2eymf` before ANY connection that could write; if it isn't, stop. Never touch /Code/nsr or its database. You own `scripts/embed-nsr/`, `scripts/serve-nsr/`, `scripts/train/`, `scripts/publish-nsr/`, `scripts/rerank-nsr/`, `scripts/eval/`, and this file — do NOT edit `api/`, `sql/`, `src/`, or top-level loader scripts (the build lane owns those tonight; the miner lane owns `scripts/mine/`). Commits allowed (your files + this doc only), gated by `npx tsc -b && npm run build`; do NOT push. Edit this file in place; the REPORT section is the deliverable.**

## Mission

The corpora (bioRxiv + medRxiv, ~433k papers) are loading into the CSHL Neon DB right now
in a parallel lane. The moment they land, we want to go: embed → mine → train → eval →
publish to HF, compressing what took NSR weeks into a day. Your job is to make every rig
**ready to fire**: ported, parameterized, dry-run-verified, with launch commands and cost
estimates written down — so each subsequent step is one approved command, not an
engineering session.

The schema you are porting against is the Task-6 DDL in `docs/prompts/LANE-RXIV-MAP.md`
(REPORT section) — read it first. If the build lane has already applied migrations, the
live CSHL DB is truth; check with a read-only `\dt` + `\d` against it. Table names, the
business key (bare DOI suffix, UNIQUE (server, doi) guard), and column names all come from
there, not from NSR habit.

## Ground

- The five rigs, all proven in production on NSR — headers in each script are authoritative:
  - `scripts/embed-nsr/` — `launch.sh` + `worker.mjs`: self-terminating g6e.xlarge (L40S)
    boxes running TEI, sharded by `PART`/`PARTS`/`LANES`, DB URL via SSM SecureString
    (`/nsr/embed/dburl`), never in user-data. Input recipe lives in SQL:
    `left(trim(title || '\n\n' || abstract), 2000)`, rows under 20 non-whitespace chars
    excluded in SQL. HNSW index built AFTER the full load.
  - `scripts/serve-nsr/` — one always-on t3.large, two TEI containers (encoder :8080/embed,
    reranker :8081/rerank), API-key-gated; `attach-reranker.sh` swaps models over SSM.
  - `scripts/train/` — FlagEmbedding fine-tune of `BAAI/bge-m3`; reranker from
    `Alibaba-NLP/gte-reranker-modernbert-base`. NSR trained its winning encoder on a ~39.6k
    triplet subsample.
  - `scripts/publish-nsr/` — HF publishing under the `NYSgpt` org (four private repos for
    NSR: encoder, reranker, triplets, benchmark).
  - `scripts/eval/` — the frozen-benchmark harness (NSR: `nsr-eval-v1`, 9,995 held-out
    queries, split by paper hash; R@k reporting per query family).
- `docs/NSR-CPT-REPORT.md` is the full model-program story — read it for the doctrine:
  frozen benchmark BEFORE training; measure stock baseline, our model, and RRF arms.
- Serving env vars (`NSR_ENCODER_URL`, `NSR_RERANKER_URL`, `NSR_SERVE_KEY`,
  `SEARCH_ENCODER`) are read by `api/_lib/embed.ts` — **api/ is not yours tonight, so the
  env-var NAMES stay as-is** even though the prefix says NSR. Renaming is a later cleanup;
  note it in the report and move on.
- This corpus differs from NSR in ways that matter to the rigs: ~100% abstract coverage
  (NSR: partial), abstracts are long, and there are ~433k papers vs 277k embedded rows.

## Tasks

1. **Port the embed rig.** Parameterize table names, business key, and SSM path (propose
   `/cshl/embed/dburl`, and stage the SecureString creation command — do not run it if it
   requires touching AWS; if `aws ssm put-parameter` is free-tier trivial, ask Brendan
   first anyway, it's an AWS write). Measure the abstract-length distribution (read-only
   SQL once rows exist) and recommend the input-recipe cap: keep 2000 chars for NSR parity
   or raise it — give the token-cost delta for both. Deliverable: a ready `launch.sh`
   invocation per shard plan (1-rig and 2-rig variants), with $/hour, projected wall-clock
   for ~433k rows, and total cost, written in the REPORT for sign-off.
2. **Port the serve rig.** Same t3.large pattern. Decide and document: serve the fine-tuned
   CSHL encoder later via the SAME box type; day-one serving needs nothing (stock bge-m3
   on Cloudflare is the `SEARCH_ENCODER=bge` path and is already how the app boots). Also
   document the MedCPT option: `ncbi/MedCPT-Query-Encoder` + `ncbi/MedCPT-Cross-Encoder`
   are in-domain for this corpus and TEI-servable — stage a variant launch config so we
   can A/B MedCPT as a serving arm, not just an eval baseline.
3. **Port the train rig.** Encoder fine-tune from `BAAI/bge-m3` (proven path) — but
   parameterize the triplet-source path to consume the miner lane's output format (see
   `docs/prompts/LANE-MINE.md` REPORT for the schema; coordinate via that file, not by
   editing their scripts). Reranker port likewise. Stage both launch commands with cost
   estimates. Note VRAM/time math for the 39.6k-subsample precedent vs a full-set run.
4. **Port the eval harness + draft `rxiv-eval-v1`.** Port the harness mechanics now
   (query → retrieve → score, R@k per family, frozen split by paper hash). Draft the
   benchmark SPEC as a proposal in the REPORT: proposed query families for this corpus —
   MeSH-term queries (published half), citation held-out pairs, synthetic LLM queries,
   plus any family the miner lane's data suggests — with sizes. The freeze itself waits
   on harvest data + Brendan's approval. Baseline arms to wire into the harness NOW:
   stock bge-m3, MedCPT (query+article encoders), SPECTER2, SciNCL, FTS, and RRF
   combinations. We are not aiming to edge past MedCPT — we're aiming to set the number
   others compare against, so the harness must make every baseline one flag away.
5. **Smoke test the write path.** Once the hub table has rows (poll read-only; the loader
   is running concurrently): embed ≤100 rows through the FREE Cloudflare bge-m3 path (no
   rig, no spend) into the embeddings sidecar exactly as the worker would, verify vector
   dim/model/text_hash columns land per schema, then DELETE the test rows and say so in
   the REPORT. This proves the entire pipe minus the GPU.
6. **Port the publish rig.** Propose the HF repo slate under `NYSgpt` (suggest `rxiv-*`:
   `rxiv-encoder-bge-m3`, `rxiv-reranker-gte-modernbert`, `rxiv-triplets`, `rxiv-eval-v1`
   — Brendan confirms names at publish time). Draft model-card skeletons mirroring NSR's,
   with the corpus/provenance sections pre-filled. No pushes.

## Report format (edit this file)

Per task: what changed vs the NSR original (file-by-file, one line each), evidence of
dry-run/smoke where applicable, then the **launch menu**: every command that costs money,
with $/h, projected duration, total, and what it unblocks — formatted so Brendan can
approve line items. End with ≤5 Decisions needed and a Blocked-on list.

## REPORT (fill in as you go)

### Log (timestamped, newest last)

> **SPEND TALLY vs the $10.50 ceiling — $0.28 committed.**
> A1 scaffolding $0 · eval sidecars $0 · aborted MedCPT rehearsal (terminated 35 s in on a
> permissions contradiction) $0.03 · **E0 rehearsal $0.25** · Neon floor 2 CU (running, restore
> to 0.25 at close) ~$0.13/h. Next spend: E1, on the ingest lane's commit signal.


- **2026-08-19 ~01:5xZ — interim 1.** Read LANE-RXIV-MAP §3/§6 (identity ruling + DDL) and
  confirmed against the LIVE db: build lane has applied sql/01–07, `preprints` matches the
  proposed DDL exactly (incl. `UNIQUE (server, doi)`, `key_number` unique, generated `fts`).
  **`preprint_embeddings` does not exist** — that is the one gap between here and "ready to
  fire" (see Blocked on). Corpus at this write: **medrxiv 80,470 rows, biorxiv 0** (loader
  still walking). Tasks 1, 2, 5 complete; 3, 4, 6 in progress. No AWS writes, no spend, no
  pushes; every AWS call so far was a read-only describe.
- **2026-08-19 05:5xZ — FINAL.** All six tasks complete. Five rigs ported and dry-run
  verified (embed both shard plans, serve both arms, train, rerank, publish); eval harness
  **ran end to end tonight against the live corpus for $0**; smoke test PASS with all 300 test
  rows and the scratch table dropped. Build gate green (`npx tsc -b && npm run build`).
  Nothing launched, nothing pushed, no spend. Launch menu below is 18 line items with $/h,
  duration and totals; minimum path to "embedded + benchmarked" is **~$1.84**, full program
  through a published encoder + reranker **~$10.50**. Two things need eyes tonight: the
  `preprint_embeddings` DDL (blocks everything) and the malformed `.env.local` line that is
  breaking `scripts/psql-cshl.sh` for every lane.

- **2026-08-19 06:2xZ — EXECUTION (menu approved, ceiling $10.50).** Brendan approved the full
  menu; the `no ML tonight` line I was given by the ingest lane turned out to be their own
  kickoff brief, retracted by them. **A1 done** (IAM role `cshl-embed` + instance profile,
  S3 `cshl-embed-rxiv`, SSM SecureString `/cshl/embed/dburl`, SG with **0 ingress rules**).
  Four eval sidecars created (medcpt/specter2/scincl 768-d, cshl 1024-d). **A2 done** — Neon
  floor 0.25→2, deliberately before the ingest lane's final upsert, because the config change
  restarts the compute and doing it at E1 time would have landed mid-transaction. **E0 done:**
  ~500 rows/s measured against a 250–325 projection, vectors clean (dim 1024, norms 1.00000,
  no zero vectors, kNN self-probe 0.0000) — and it caught two defects, both cheap now and
  expensive later: `text_hash` was md5 of a JS-trimmed string while SQL authored the string
  (2/3,000 rows could never match their own recomputed hash, which would have made the
  mandatory `RECLAIM_STALE` pass churn forever), and the rig hung 3+ minutes in `apt` with TEI
  healthy and the box billing. Both fixed. Slate renamed `rxiv-*` → `cshl-*` per Brendan.
  `scripts/eval/recipe.mjs` is now the single definition of the embed string and lane-mine
  imports it rather than copying it. **P-block: I declined to publish while it was reserved to
  Brendan; he then ruled personally, so it proceeds — the write-up states the NSR-token reuse
  as an open follow-up.** S-block starts at T2, when there is something to serve.

---

### §5-DDL — the embeddings sidecar the build lane needs to apply (proposal, NOT applied)

Ready for `sql/08-embeddings.sql`. This exact DDL (name aside) was executed against the live
CSHL db during the Task-5 smoke test and then dropped — so it is verified, not drafted.

```sql
-- 08: bge-m3 vectors for the preprint corpus. Sidecar, keyed by the business key,
-- mirrors LANE-RXIV-MAP §6. Written by scripts/embed-nsr/worker.mjs.
BEGIN;
CREATE TABLE IF NOT EXISTS preprint_embeddings (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number),
  embedding   vector(1024) NOT NULL,
  model       text NOT NULL DEFAULT 'bge-m3',
  text_hash   text NOT NULL,          -- md5 of the EXACT string sent to the encoder
  embedded_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;

-- HNSW AFTER the full embed pass, never before (index maintenance during a 433k-row
-- upsert sweep is the whole cost). Run this as its own statement once the sweep is green:
--   CREATE INDEX IF NOT EXISTS idx_pp_emb_hnsw
--     ON preprint_embeddings USING hnsw (embedding vector_cosine_ops);
```

Two notes for whoever applies it. (a) The FK to `preprints(key_number)` is what makes the
worker's resume predicate exact; keep it. (b) `model` is NOT decorative — the fine-tuned
encoder writes its own value here, and an arm that silently claims to be stock bge-m3 is how
an eval table lies. The worker sets it explicitly on every upsert.

For the eval baselines (Task 4) the same shape repeats at other dimensions — MedCPT /
SPECTER2 / SciNCL are all **768-d**, so each needs its own `vector(768)` sidecar. The harness
creates these itself under `scripts/eval/`; they are not the build lane's problem.


---

## Deliverables

### 1 Embed rig — PORTED, dry-run verified (both shard plans)

| file | change |
|---|---|
| `scripts/embed-nsr/launch.sh` | every NSR-ism is an env knob with a CSHL default (`TABLE`/`EMB_TABLE`/`KEY`/`CAP`/`DIM`/`PARAM=/cshl/embed/dburl`/`ROLE=cshl-embed`/`BUCKET=cshl-embed-rxiv`); bounds query reads `preprints LEFT JOIN preprint_embeddings` |
| `scripts/embed-nsr/launch.sh` | **`DRYRUN=1`** — computes bounds and prints the full user-data + `run-instances` argv while touching nothing in AWS. This is the sign-off artifact and the reason nothing was launched tonight |
| `scripts/embed-nsr/launch.sh` | **DB endpoint fence** (`ep-orange-water-aut2eymf`) before any connection — a rig that writes vectors into the wrong database is not recoverable by apology |
| `scripts/embed-nsr/launch.sh` | **secret redaction in dry-run output** — see the defect note below |
| `scripts/embed-nsr/launch.sh` | **missing-sidecar preflight**: a clear "apply the DDL first" instead of a raw psql `relation does not exist` three steps into the output |
| `scripts/embed-nsr/launch.sh` | `MODEL_S3=` syncs fine-tuned weights from S3 and mounts them — this is the train rig's Phase 3, moved onto the rig that is already sharded and resume-safe |
| `scripts/embed-nsr/worker.mjs` | table/key/cap/dim/model from env, SQL built once at startup; identifiers shape-validated before interpolation |
| `scripts/embed-nsr/worker.mjs` | writes `model` explicitly on every upsert — a fine-tuned run must never masquerade as stock bge-m3 in the sidecar |
| `scripts/embed-nsr/worker.mjs` | `CHUNK` default 128 → 64 (rxiv inputs are ~3.5× NSR's; 128 long texts in one TEI call would blow `--max-batch-tokens`) |
| `scripts/embed-nsr/worker.mjs` | `RECLAIM_STALE=1` re-claims rows whose `text_hash` no longer matches the recipe (the revision case `ON DELETE CASCADE` cannot see) |
| `scripts/embed-nsr/worker.mjs` | `DRY_SQL=1` prints the two statements and exits; `pg` import made lazy so this runs from the laptop |
| `scripts/embed-nsr/smoke-cloudflare.mjs` | **new** — Task 5, below |

**Defect found and fixed in my own port.** The first `DRYRUN=1` run printed the live Neon
connection string, password included, to stdout — the same class of leak the NSR train rig's
header documents (`set -x` printing resolved values into three uploaded S3 logs). A dry-run
whose entire purpose is to be pasted into a report is a *worse* place to leak a credential
than a log file. Fixed with a `redact()` helper that blanks anything after `--value`. **That
password was exposed in my session transcript before the fix — it should be rotated.** It was
already on the NSR project's owed list; this is a second reason.

**Dry-run evidence (no AWS touched, read-only DB):**

```
$ DRYRUN=1 N=1 ./scripts/embed-nsr/launch.sh
db endpoint: ep-orange-water-aut2eymf (fence ok)
  [dry-run] would run: aws ssm put-parameter --name /cshl/embed/dburl --type SecureString --value <redacted> ...
bounds (4 lanes): 2020.07.30.227769,2022.06.21.22276722,229468,873232

$ DRYRUN=1 N=2 ./scripts/embed-nsr/launch.sh
bounds (8 lanes): 2020.08.21.20179739,2021.05.10.21256958,2022.03.11.22272263,2023.03.09.23287051,
                  2024.01.31.24302098,2024.11.07.24316939,2025.07.30.25332459,2026.04.21.26351358
```

Both worker statements were then PREPAREd against the live database (scratch sidecar, dropped
after): plan is `Merge Anti Join` on the key ordering — no seq scan — and `Merge Left Join`
with `RECLAIM_STALE=1`. The upsert parses clean.

**A correction to a claim I first wrote into the comments.** I initially noted that rxiv's
bare legacy keys (`001891`, `229468`) sort *below* every dotted key. They do not: under
lexical ordering the two shapes **interleave** — the dry-run above puts `229468` between
`2022…` and `2026…`. So `REHEARSE_LO` does not carve out a clean date slice; it carves out a
key range that mostly contains recent papers plus legacy strays. Fine for a throughput
rehearsal, wrong for anything else, and now said that way in both files.

#### Input-recipe cap — measured, recommendation: **4000** (lead has provisionally adopted)

Measured read-only over 197,539 loaded rows. **Abstract coverage is 100.0%** — zero rows
without an abstract, which is the headline difference from NSR (partial coverage, mostly
title-only rows).

| server | n | p50 | p90 | p97 | p99 | whole @2000 | whole @4000 | whole @5000 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| bioRxiv | 117,069 | 1,550 | 2,393 | 2,921 | 3,403 | 79.3% | **99.8%** | 99.9% |
| medRxiv | 80,470 | 1,941 | 2,986 | 3,789 | 4,763 | 54.6% | **97.7%** | 99.2% |
| combined | 197,539 | 1,723 | 2,657 | 3,359 | 4,041 | 69.2% | **98.9%** | 99.6% |

**Token-cost delta.** Mean input length is what the GPU actually pays for:

| cap | mean input chars | vs 2000 | documents left whole | $ delta on a ~$1.00 full run |
|---|---:|---:|---:|---:|
| 2000 (NSR parity) | 1,628 | — | 69.2% | — |
| **4000 (recommended)** | **1,802** | **+10.7%** | **98.9%** | **+$0.11** |
| 5000 | 1,808 | +11.1% | 99.6% | +$0.11 |

Eleven cents to stop truncating a third of the corpus mid-abstract. Above 4000 the curve is
flat — 5000 costs another 0.3% for another 0.7pp of whole documents, so it is essentially
free if you want it; I recommend 4000 and the model card documents 4000.

#### Throughput and cost projection

NSR measured **1,089 rows/s sustained at N=1** (g6e.xlarge, 4 lanes, TEI bge-m3 fp16) on a
corpus averaging ~128 tokens per input ⇒ roughly **139k tokens/s** of encoder throughput.
Our mean input at cap 4000 is ~1,802 chars ≈ **~430 tokens**, so the same box should sustain
**~250–325 rows/s**. Plan on 280.

| plan | embed time (433k rows) | + boot/model-pull | billable | $/h | **total** |
|---|---|---|---|---|---|
| N=1 | 22–29 min | ~6 min | ~0.47–0.58 h | $1.861 | **$0.87 – $1.09** |
| **N=2 (recommended)** | 11–14 min | ~6 min | 2 × ~0.33 h | $1.861 | **~$1.23** |
| N=4 | 6–7 min | ~6 min | 4 × ~0.22 h | $1.861 | **~$1.64** |

N=2 halves the wall-clock for about a quarter. G quota is **64 vCPUs** (verified read-only —
the request NSR filed was approved), so up to 16 boxes are available; past N=4 the fixed
boot cost dominates and it stops buying anything. **These are projections from NSR's measured
token throughput, not measurements of this corpus** — the bounded rehearsal below converts
them to fact for ~$0.06.

---

### 2 Serve rig — PORTED, both arms dry-run verified

| file | change |
|---|---|
| `scripts/serve-nsr/launch.sh` | `ARM=cshl` (S3 weights) / **`ARM=medcpt` (new)**; SSM `/cshl/serve/api-key`, role/bucket/SG parameterized; `DRYRUN=1`; persistent HF cache volume for hub models so a container restart does not re-download |
| `scripts/serve-nsr/attach-reranker.sh` | `RR_ID=` accepts a **Hub id** as well as an S3 run — swapping in `ncbi/MedCPT-Cross-Encoder` on a live box is now one command, no relaunch, no retrain, no weights |

**Day-one serving needs nothing.** The app already boots on `SEARCH_ENCODER=bge` → stock
bge-m3 via Cloudflare Workers AI, free tier, no box. The serve rig is only needed to serve
*our* fine-tune or to A/B MedCPT. Same t3.large pattern as NSR: **$0.083/h ≈ $2/day while
on**, stop it and the app falls back instantly.

**MedCPT — the thing worth knowing before anyone plans around it.** All three NCBI repos
exist and carry the `text-embeddings-inference` tag (verified on the Hub). But MedCPT is an
**asymmetric 768-d dual encoder**: queries go through `MedCPT-Query-Encoder` (max 64 tokens),
documents through `MedCPT-Article-Encoder` (max 512 tokens), and the two are comparable only
to each other. Consequences, split honestly:

- **`MedCPT-Cross-Encoder` as a rerank arm: a genuine drop-in today.** Rerank scores are
  dimensionless. `RR_ID=ncbi/MedCPT-Cross-Encoder INSTANCE=<i-…> ./attach-reranker.sh` and
  the existing `NSR_RERANKER_URL` path serves it unchanged. This is the cheapest real A/B we
  have.
- **MedCPT as the *dense* arm: not a drop-in.** `api/_lib/embed.ts` hard-fails a vector whose
  length ≠ 1024 and the corpus sidecar is `vector(1024)`. Serving it needs a
  `preprint_embeddings_medcpt vector(768)` sidecar (the harness builds this; approved) **and**
  an `api/` change. `api/` is not mine tonight — flagged, not attempted.
- Note also that MedCPT truncates articles at 512 tokens (~2,000 chars), so on this corpus it
  sees roughly the 2000-cap version of each document no matter what our cap is. Worth
  remembering when reading its number.

**Env-var naming, as instructed:** `NSR_ENCODER_URL` / `NSR_RERANKER_URL` / `NSR_SERVE_KEY` /
`SEARCH_ENCODER=nsr` keep their NSR-prefixed names because `api/` is not this lane's tonight.
The serve rig prints the exact wiring line with those names. Renaming is a later cleanup and
belongs in one commit with `api/_lib/embed.ts`.

---

### 3 Train rig — PORTED, dry-run verified; converter proven on a fixture

| file | change |
|---|---|
| `scripts/train/launch.sh` | **new** (port of `scripts/train-nsr/launch.sh`) — names/SSM/bucket parameterized, `DRYRUN=1`, endpoint fence, `TRAIN_ARGS` passthrough |
| `scripts/train/launch.sh` | NSR's Phase-3 `candidate-embed.py` **dropped**: it was a single-threaded loop over 277k rows running on the box that had just finished training. Our corpus is 433k and the embed rig already does this, sharded and resume-safe. Phase 3 is now one `MODEL_S3=…` invocation of the embed rig |
| `scripts/train/train.sh` | **new** (port) — all three hard-won AMI facts inherited verbatim (`/opt/pytorch/bin/python3`; `LD_LIBRARY_PATH` over every `nvidia/*/lib`; pin `transformers<5` or `AbsTrainer._save` dies *after* a successful run) |
| `scripts/train/train.sh` | `PASSAGE_MAX_LEN` default **256 → 512**: this corpus averages ~430 tokens per document, so 256 would train on roughly half the text the embed rig actually indexes — train and serve would see different documents |
| `scripts/train/train.sh` | `BATCH` start 16 → 8 (doubling passage length roughly doubles activation memory); the OOM-halving loop is unchanged and self-corrects in both directions, and the log records what actually held |
| `scripts/train/train.sh` | **refuses to train** on a slice whose `manifest.json` does not assert `disjointness.pass = true` |
| `scripts/train/train.sh` | rehearsal sanity-embed no longer needs a DB (embeds the slice's own passages) — one less credential on the box |
| `scripts/train/to-flag.mjs` | **new** — miner contract → FlagEmbedding `train.jsonl`, with the holdout gate |
| `scripts/train/upload-slice.sh` | **new** — the manifest travels *with* the slice; refuses to upload a set that fails disjointness |
| `scripts/rerank-nsr/launch.sh` | names/bucket/SSM parameterized; `TRAIN_PY=` knob; 44b's `train.py` still runs **unchanged** |
| `scripts/rerank-nsr/train.sh` | on-box scoring step **removed** — it queried `nsr_eval_queries`/`nsr_embeddings`, neither of which exists here nor should. Scoring is now `scripts/eval/score.mjs`'s `rerank:` composite arm against a serving endpoint, so **no DB credential reaches the reranker box at all** |
| `scripts/rerank-nsr/to-groups.mjs` | **new** — the *same* miner contract → `train-groups.jsonl`. One harvest feeds both models instead of two mining passes with two chances to disagree about the holdout |

#### The miner-lane contract (coordination point — LANE-MINE, please read)

Both converters read **`data/mine/triplets.jsonl`**, one JSON object per line:

```json
{"anchor_key":"2024.01.02.123456","query":"<text, or null>",
 "positives":["<key_number>",...],"negatives":["<key_number>",...],
 "source":"citations|mesh|synth|category"}
```

Keys only — text is resolved from `preprints` at convert time, so a mined set stays valid
when the input recipe changes. `query: null` means "use the anchor paper's own title+abstract"
(the SPECTER/SciNCL doc-doc recipe). Everything else in the object is ignored. Benchmark
families use a sibling contract, `data/mine/<family>.jsonl` with `{qid, family, text,
positives[], source}`.

#### The holdout gate, and why it is a hard failure

NSR's first mining sweep leaked held-out papers into **24.7% of negative slots** and cost a
full retrain. So: the same hash rule (`md5("holdout:" || key_number) < 0.25`) is used by the
benchmark builder, the encoder converter and the reranker converter, and both converters
**audit what they emit, not what they read**, and write nothing if a held-out paper survives.

Proven on a 20-record fixture built from real keys (fixture deleted after):

```
20 mined records → resolved 32/32 keys → emitting 12 pairs (8 records dropped)
holdout audit (pre-filter):  {"anchors_held_out":4,"positives_held_out":4,"negatives_held_out":22}
holdout audit (emitted):     {"anchors":0,"positives":0,"negatives":0}
wrote data/train/fixture/train.jsonl + manifest.json — disjointness.pass = true
```

The first version of this audit was **wrong in the scary direction**: it counted held-out
positives from the *input* record rather than the output, so it reported DISJOINTNESS FAIL on
a set that was actually clean. The fixture caught it. A gate that cries wolf gets disabled,
which is how you end up with NSR's bug from the other side.

#### VRAM / time math: the 39.6k precedent vs a full set

NSR's winning encoder: **39,568 pairs, group 8, q128/p256, batch 16, 1 epoch, 33.5 min**
train, 46.7 min box, **$1.45** — the pair count was a 60-minute *night budget*, not a quality
finding. Scaling to this corpus at p512:

| run | pairs | tokens/step vs NSR | expected batch | est. train | est. box | **est. $** |
|---|---:|---|---:|---|---|---:|
| rehearsal | ~1,000 | 2× | 8 | ~2 min | ~12 min | **~$0.37** |
| NSR-parity | ~40,000 | 2× | 8 | ~65 min | ~80 min | **~$2.48** |
| full set, 1 epoch | ~120,000 | 2× | 8 | ~3.3 h | ~3.5 h | **~$6.50** |
| full set, 2 epochs | ~120,000 | 2× | 8 | ~6.5 h | ~6.8 h | **~$12.65** |

The OOM loop makes the batch guess safe rather than fatal — worst case it halves to 4 and the
run takes longer, which the `WATCHDOG_MIN` cap bounds. **Recommendation: rehearsal, then the
NSR-parity run.** NSR got +186% R@10 out of 39.6k pairs; buy the full-set run with evidence
from the parity run, not before.

---

### 4 Eval harness — PORTED and **running today**; `rxiv-eval-v1` drafted

| file | change |
|---|---|
| `scripts/eval/build-rxiv-eval.mjs` | **new** (port of `build-nsr-eval.mjs`). NSR welded in two families sourced from NSR-only tables. Families are now **pluggable** jsonl files from the miner lane, plus one built-in that needs no external data |
| `scripts/eval/build-rxiv-eval.mjs` | rxiv segments (`server` / `era` / `published` / abstract-length band) replace NSR's era/richness/reftype; manifest records per-family provenance **and the miner file's own hash** |
| `scripts/eval/score.mjs` | **rewritten around an ARM REGISTRY.** NSR had five near-identical `runArmA..D` functions, each with its own table name and query-embedding loader — the shape that makes "add MedCPT" a code change. Now `ARMS=fts,bge-m3,medcpt,specter2,scincl,rxiv` is the whole interface and adding a baseline is one registry line |
| `scripts/eval/score.mjs` | RRF and rerank are **composite arms parsed from the flag** (`rrf:fts+bge-m3`, `rerank:bge-m3@http://ip:8081`), not bespoke functions |
| `scripts/eval/score.mjs` | **per-arm vector dimension** — MedCPT/SPECTER2/SciNCL are 768-d, bge-m3 is 1024-d. NSR could assume one dimension; we cannot |
| `scripts/eval/score.mjs` | a failing arm is caught and skipped — a dead arm costs one arm, not the run (NSR's own rule, now enforced in code) |
| `scripts/eval/embed-queries.mjs` | **new**, replaces NSR's two near-identical provider scripts with one: `cloudflare` (free) / `tei` (any box) / `hf`. Resumable, and it **hard-fails if the returned dimension disagrees with the registry** |

**Every baseline is one flag away, as asked.** The corpus side of a 768-d arm reuses the embed
rig — `MODEL=ncbi/MedCPT-Article-Encoder DIM=768 EMB_TABLE=preprint_embeddings_medcpt N=1
./scripts/embed-nsr/launch.sh` — rather than a second embedder.

**Evidence — the harness ran end to end tonight, against the live corpus, for $0:**

```
$ EVAL_VERSION=rxiv-eval-v0-draft node scripts/eval/build-rxiv-eval.mjs
corpus: 197539 rows, 197539 embeddable
holdout: 49503/197539 papers (25.1%, target 25%)
family TITLE  raw 49486  after_holdout 49486  frozen 1000
leak audit (non-TITLE families): 0/0

$ ARM=bge-m3 node scripts/eval/embed-queries.mjs
done: 1000 query vectors (dim 1024) in 41.3s   # Cloudflare free tier, $0, ~23 q/s

$ ARMS=fts LIMIT=300 node scripts/eval/score.mjs
  TITLE blended: R@1 0.9933 R@10 0.9933 nDCG@10 0.9933 (n=300)
```

That 0.9933 is **not a result** and the harness says so in its own comments. `TITLE` (a
paper's title as the query, that paper as the answer) is leaked by construction, because the
indexed document *is* title+abstract. It exists so the plumbing — segments, metrics, arm
wiring, holdout — is proven on day zero, and as a floor: an arm that cannot find a paper from
its own title is broken, not merely weak. It is reported separately and never blended.

#### `rxiv-eval-v1` — proposed spec (freeze waits on harvest + your approval)

Split: **25% of papers** by `md5("holdout:" || key_number)`, frozen before training, split by
paper so a paper's queries can never straddle the boundary. Measured on the real corpus:
25.1%.

| family | proposed size | source | query-shaped? | depends on |
|---|---:|---|---|---|
| `MESH` | 5,000 | NLM MeSH descriptors on the ~49% published half | partly | LANE-MINE MeSH harvest |
| `CITE` | 5,000 | held-out citation pairs (cited work = positive) | no — doc-doc | LANE-MINE citation harvest |
| `SYNTH` | 5,000 | LLM questions over held-out abstracts | **yes** | LANE-MINE Bedrock gen (spend gate) |
| `CATEGORY` | 2,000 | the paper's category as a query, 76 classes | weakly | nothing — free today |
| `TITLE` | 5,000 | the paper's own title | n/a — **leaked by construction** | nothing — free today |

~22,000 queries against a ~433k-document universe, versus NSR's 9,995 against 277k. One
family I'd add if the miner lane's data supports it: **`PUBTITLE`** — the *journal* title of
the published version as the query against the preprint. It is query-shaped, unleaked (the
journal title is not in our indexed text), and free from the `pubs` endpoint the map lane
already inventoried.

`SYNTH` is the family that matters most and the only one that is genuinely query-shaped.
`CITE` and `MESH` measure document similarity and topical labelling; real users type
questions. If the Bedrock spend gate is refused, say so early — the benchmark is still
publishable without it, but it is measuring something narrower and the card should say that.

**Baselines wired now, one flag each:** Postgres FTS · stock `BAAI/bge-m3` ·
`ncbi/MedCPT` (query + article) · `allenai/specter2_base` · `malteos/scincl` ·
our `rxiv-encoder-bge-m3` · any `rrf:A+B` · any `rerank:A@url`.

Two caveats I will not paper over. **SPECTER2 proper** is `allenai/specter2_base` **plus** a
proximity *adapter*, and TEI cannot load adapters — the registry entry is the base encoder,
which is a legitimate and commonly reported arm but is not SPECTER2-with-adapter. **SciNCL**
is the one model in the set without the `text-embeddings-inference` tag; it is a plain BERT
and should serve, but that is an expectation, not a verified fact, and it uses CLS pooling.
Both are noted in the registry.

---

### 5 Smoke test — **PASS**, 300 test rows written and deleted, scratch table dropped

`scripts/embed-nsr/smoke-cloudflare.mjs` (new) runs the entire pipe minus the GPU: the
worker's exact page query → bge-m3 via **Cloudflare Workers AI free tier** ($0, no rig) → the
worker's exact `unnest`/`ON CONFLICT` upsert → pgvector → verification → cleanup.

```
db endpoint: ep-orange-water-aut2eymf.c-10.us-east-1.aws.neon.tech (fence ok)
claimed 100 rows; input chars min/mean/max = 403/2145/3993
embedded 100 texts in 3.5s (cloudflare free tier, $0)
upsert ran twice (idempotency check)
verification: {"n":100,"distinct_keys":100,"min_dims":1024,"max_dims":1024,"model_ok":100,
               "hash_shape_ok":100,"null_embedded_at":0,"min_norm":"0.99966","max_norm":"1.00032",
               "zero_vectors":0}
text_hash parity vs the SQL recipe: 0 mismatches
resume predicate: 0 embedded rows still claimable (want 0)
kNN self-probe: top1=19000109 d=0.000000 (self=19000109) next_d=0.4101
SMOKE PASS
cleanup: deleted 300 test rows, dropped preprint_embeddings_smoke (gone=true)
```

Verified: **dim 1024**, `model` column set explicitly on every row, `text_hash` matches
`md5()` of the DB's own recipe output (0 mismatches — so the worker and the SQL agree
byte-for-byte), unit norms, no zero vectors, `embedded_at` populated, the upsert is idempotent
across two passes, the resume predicate correctly stops re-claiming embedded rows, and a kNN
self-probe returns the paper itself at distance 0.

**Cleanup, stated plainly:** three runs wrote 300 rows total into
`preprint_embeddings_smoke`; all 300 were deleted with the table, and
`pg_tables LIKE '%smoke%'` returns none. Nothing else in the CSHL database was written by this
lane — every other query was read-only.

**Why a scratch table.** `preprint_embeddings` did not exist when I ran this and `sql/` is the
build lane's. I ran the real DDL (name aside) against the live database, proved the pipe on
it, dropped it, and filed the verified DDL for the build lane rather than inventing their
migration under them. The lead has since routed it; it lands via `finish-load.sh` with an
`ON DELETE CASCADE` amendment I have confirmed (see DIRECTIVES).

---

### 6 Publish rig — PORTED, four card skeletons drafted, **nothing pushed**

| file | change |
|---|---|
| `scripts/publish-nsr/launch.sh` | `CARD=` is now a **local path** this script uploads for you. NSR required the card to already be in S3 by hand, which is how a model ships with a stale card |
| `scripts/publish-nsr/launch.sh` | **refuses to publish a card containing `{{PLACEHOLDER}}` markers**, listing the ones it found |
| `scripts/publish-nsr/launch.sh` | `DRYRUN=1`; `PRIVATE=True` default and printed; SSM `/cshl/hf/token` (falls back to the existing `/nsr/hf/token`) |
| `scripts/publish-nsr/cards/_CORPUS.md` | **new** — one shared corpus/provenance/split block, included verbatim by all four cards so it can only be updated in one place |
| `scripts/publish-nsr/cards/rxiv-encoder-bge-m3.md` | **new** — training table, baseline comparison table, limitations |
| `scripts/publish-nsr/cards/rxiv-reranker-gte-modernbert.md` | **new** — reports **delta over the arm it reranks**, plus the honest per-candidate serving cost |
| `scripts/publish-nsr/cards/rxiv-triplets.md` | **new** — supervision-source table and the holdout guarantee |
| `scripts/publish-nsr/cards/rxiv-eval-v1.md` | **new** — family table with `TITLE` flagged as leaked-by-construction, split rule, reproduction commands |

**Proposed slate under `NYSgpt`, all private at first push** — `rxiv-encoder-bge-m3`,
`rxiv-reranker-gte-modernbert`, `rxiv-triplets` (dataset), `rxiv-eval-v1` (dataset).

Corpus/provenance sections are pre-filled from measurements; run-derived numbers are
`{{PLACEHOLDER}}` markers that the launcher blocks on. The guard works:

```
$ DRYRUN=1 SRC=… REPO=NYSgpt/rxiv-encoder-bge-m3 CARD=…/rxiv-encoder-bge-m3.md ./launch.sh
REFUSING: … still contains {{PLACEHOLDER}} markers:
  {{BATCH}} {{BGE_NDCG}} {{BIORXIV_N}} …
Fill them from the actual run before publishing. A card with placeholders is worse than no card.
```

One thing the cards state that needs your eye before anything goes public: **licensing.**
Preprint abstracts are redistributed by the servers under per-paper licenses (7 distinct
values in the corpus; only 39,908 of 197,539 loaded rows are `cc_by`). The triplets dataset
contains abstract text. NSR's equivalent question (NNDC redistribution terms) is still open on
that project. **Confirm CSHL's terms before any repo is flipped public** — private pushes are
fine.

---

## Launch menu (needs sign-off)

Nothing below has been run. Every line is one command, already dry-run verified.
`$1.861/h` = g6e.xlarge on-demand; `$0.083/h` = t3.large.

| # | what | command | $/h | duration | **total** | unblocks |
|---|---|---|---|---|---|---|
| **A0** | Apply the embeddings sidecar DDL | build lane / `finish-load.sh` | — | ~1 min | **$0** | everything below |
| **A1** | Create AWS scaffolding: SSM SecureString `/cshl/embed/dburl`, IAM role `cshl-embed`, SG, S3 bucket `cshl-embed-rxiv` | first non-dry-run `./scripts/embed-nsr/launch.sh` | — | ~1 min | **$0** (free tier) | every rig; **AWS writes — needs your go** |
| **A2** | Neon compute floor 0.25 → 2 CU for the sweep (the house law), restored after | `scripts/neon-scale.mjs` | — | ~40 min | **~$0.16** | write throughput during the sweep |
| **E0** | **Bounded rehearsal** — 3,000 rows, converts the projection below into a measurement | `REHEARSE=3000 REHEARSE_LO=2024 N=1 ./scripts/embed-nsr/launch.sh` | $1.861 | ~8 min | **~$0.25** | confidence in E1's number |
| **E1** | **Embed the corpus, stock bge-m3, cap 4000** (+10.7% tokens vs cap 2000, +$0.11 — 98.9% of documents left whole instead of 69.2%) | `N=2 ./scripts/embed-nsr/launch.sh` | $1.861 ×2 | ~17–21 min | **~$1.23** | dense search, triplet mining, every eval arm |
| | └ 1-rig variant, ~10 min slower | `N=1 ./scripts/embed-nsr/launch.sh` | $1.861 | ~28–35 min | **~$1.00** | same |
| | └ 4-rig variant, diminishing | `N=4 ./scripts/embed-nsr/launch.sh` | $1.861 ×4 | ~13 min | **~$1.64** | same |
| **E2** | HNSW index build (after E1, never before) | one `CREATE INDEX` | — | ~10–20 min | **~$0.20** (Neon compute) | sub-50 ms kNN |
| **B1** | Eval baseline: MedCPT article encoder over the corpus, 768-d sidecar | `MODEL=ncbi/MedCPT-Article-Encoder DIM=768 EMB_TABLE=preprint_embeddings_medcpt N=1 …/launch.sh` | $1.861 | ~30 min | **~$1.00** | the in-domain baseline that matters most |
| **B2** | Eval baselines: SPECTER2 + SciNCL, same shape | two runs, or one box sequentially | $1.861 | ~60 min | **~$2.00** | the scholarly-embedding baselines |
| **B3** | Query-side embeds for B1/B2 | fold into the same boxes | — | +2 min | **$0** | scoring those arms |
| **B4** | Query-side embeds, stock bge-m3 | `ARM=bge-m3 node scripts/eval/embed-queries.mjs` | — | ~15 min | **$0** (Cloudflare free) | the bge-m3 arm — **already proven tonight** |
| **T0** | Encoder training rehearsal (~1k pairs) | `MODE=rehearse TRAIN_NAME=rehearsal ./scripts/train/launch.sh` | $1.861 | ~12 min | **~$0.37** | de-risks T1 |
| **T1** | Encoder fine-tune, NSR-parity set (~40k pairs, 1 epoch) | `MODE=train TRAIN_NAME=parity ./scripts/train/launch.sh` | $1.861 | ~80 min | **~$2.48** | `rxiv-encoder-bge-m3` |
| | └ full set (~120k, 1 epoch) — buy with evidence from T1 | same, `TRAIN_NAME=full` | $1.861 | ~3.5 h | **~$6.50** | possibly better, unproven |
| **T2** | Re-embed the corpus with the fine-tune (train Phase 3) | `MODEL_S3=… EMB_TABLE=preprint_embeddings_rxiv N=2 …/embed-nsr/launch.sh` | $1.861 ×2 | ~20 min | **~$1.23** | scoring our own arm |
| **T3** | Reranker fine-tune (~40k groups, 2 epochs) | `MODE=train TRAIN_NAME=parity ./scripts/rerank-nsr/launch.sh` | $1.861 | ~45 min | **~$1.70** | `rxiv-reranker-gte-modernbert` |
| **S1** | Serve box for our encoder (+ reranker) | `ARM=cshl ENC_RUN=<run> ./scripts/serve-nsr/launch.sh` | $0.083 | ongoing | **~$2/day while on** | `SEARCH_ENCODER=nsr` in prod |
| **S2** | MedCPT cross-encoder A/B on a running serve box | `RR_ID=ncbi/MedCPT-Cross-Encoder INSTANCE=<i-…> ./attach-reranker.sh` | — | ~3 min | **$0** marginal | rerank comparison |
| **P1** | Publish 4 private HF repos | 4 × `./scripts/publish-nsr/launch.sh` | — | ~5 min | **~$0.05** | the deliverable; **needs a separate go — public-facing** |

**Minimum path to "embedded + benchmarked":** A0 + A1 + A2 + E0 + E1 + E2 + B4 ≈ **$1.84**.
**Full program through a published encoder + reranker, NSR-parity sizing:** ≈ **$10.50**
one-off, plus ~$2/day if the serve box stays up. NSR's comparable night was ≈$9.

---

## Decisions needed

1. **Shard plan for E1 — N=2 (~$1.23, ~20 min) or N=1 (~$1.00, ~30 min)?** I recommend N=2:
   ten minutes of the critical path for a quarter, and the corpus is 56% larger than NSR's.
   Fire E0 first (~$0.25) if you want the throughput number measured rather than projected.
2. **Which baseline arms to fund.** MedCPT only (**~$1.00**) or MedCPT + SPECTER2 + SciNCL
   (**~$3.00**)? If the goal is to set the number others compare against, all three — the
   marginal $2 buys the two arms a reviewer will ask about. If it is speed to a working
   product, MedCPT alone.
3. **Training set size for T1.** NSR-parity ~40k pairs (**~$2.48**) or the full mined set
   (**~$6.50**)? Recommend parity first: NSR got +186% R@10 out of 39.6k, and the full-set
   run is a better purchase once we have a number to beat.
4. **HF repo names + private-first**, and **the licensing question above** before anything is
   flipped public. `rxiv-encoder-bge-m3` / `rxiv-reranker-gte-modernbert` / `rxiv-triplets` /
   `rxiv-eval-v1` under `NYSgpt`.
5. **Rotate the Neon password.** My dry-run printed it before I fixed the redaction (§1). It
   was already owed from the NSR project.

## Blocked on

- **`preprint_embeddings` DDL** — `sql/08-embeddings.sql` now exists on disk, written by the
  build lane exactly as proposed plus the `ON DELETE CASCADE` amendment, but as of 05:55Z it
  is **not yet applied** (`to_regclass('preprint_embeddings')` → null); it lands with
  `finish-load.sh`. Until then the embed rig stops at its preflight with a clear message.
  *Everything downstream waits on this one table.* The worker's default `EMB_TABLE` already
  matches the name, so nothing on my side changes when it lands.
- **bioRxiv load completing** — 197,539 of ~433k rows at 05:48Z (bioRxiv 117,069 + medRxiv
  80,470). The rig is resume-safe, so a partial load is survivable: embed what is there and
  re-run for the remainder at no extra engineering cost. All measurements above are on the
  loaded subset and will shift slightly.
- **LANE-MINE triplet output** — contract declared above (`data/mine/triplets.jsonl`) and both
  converters are written and fixture-proven against it. Nothing to do but receive the file.
- **`SYNTH` query family** — depends on the miner lane's Bedrock spend gate. If refused, the
  benchmark ships without its only genuinely query-shaped family; the card must say so.
- ~~`.env.local` line 29 malformed, breaking `scripts/psql-cshl.sh` for every lane~~ —
  **RESOLVED** by the lead at ~05:5xZ; re-verified working from this lane, local wrapper
  deleted.
- **HF token for CSHL** — `/cshl/hf/token` does not exist; `/nsr/hf/token` does. Either reuse
  it or mint a CSHL-scoped one before P1.
- **MedCPT as a serving dense arm** needs an `api/_lib/embed.ts` change (1024-d hard-coded).
  Flagged, not attempted — `api/` is not this lane's.


---

## DIRECTIVES — lead → lane (comms channel)

Protocol: after you file any entry in the REPORT section above, and at every natural pause
in long-running work, re-read this section. Act on each unchecked item, then check it off
(`- [x]`) and append a one-line result to it. If a directive conflicts with your HARD CAPS,
the caps win — decline in your report rather than acting. Never edit another lane's file.
If one of your own full-file writes ever drops this section, restore it. The lead watches
this file and responds here after your reports.

- [x] Acknowledge this channel: check this box and note your current step in one line. — **ACK 2026-08-19.** Channel read; re-reading DIRECTIVES after every REPORT filing and at every pause. Current step: embed rig ported (launch.sh + worker.mjs), Task-5 smoke test running against a scratch sidecar (`preprint_embeddings` does not exist yet — sql/ is the build lane's; DDL proposal will be in my REPORT). No AWS calls beyond read-only describes, no spend.
- [x] Scratch sidecar for the smoke test is approved under the Task-5 exception — name it unmistakably (`_smoke_embeddings` or similar), DROP it when done, and state the drop in your REPORT. — **DONE, ahead of the directive.** Table was `preprint_embeddings_smoke`; 3 runs wrote 300 rows total, all dropped with the table; `pg_tables LIKE '%smoke%'` returns none. Stated in REPORT §5.
- [x] File your embeddings-sidecar DDL proposal in the REPORT as soon as it's stable. The lead will route it to the build lane (sql/ owner) so the real table exists before the embed launch menu gets approved — flag its exact name here once you two converge so worker.mjs targets it. — **FILED, REPORT §5 DDL.** Name: **`preprint_embeddings`** (LANE-RXIV-MAP §6's name, unchanged); next free file number is `sql/08-embeddings.sql` (build lane took 07-reindex). It is the worker's default `EMB_TABLE`, so nothing changes in my scripts if the build lane uses that name; if they pick another, one env var covers it. DDL verified by running it verbatim (name aside) in the smoke test.
- [x] The hub table already holds 80,470 final medRxiv rows — run your abstract-length distribution query now (read-only) and put the input-recipe cap recommendation with token-cost delta in the REPORT; don't wait for bioRxiv to finish. — **DONE, ahead of the directive.** n=80,470, **0 rows without an abstract**, p50 1,941 / p90 2,986 / p99 4,763 chars. **Recommendation: raise the cap 2000 → 4000** (+16.0% token cost, +$0.15–0.21 on the whole run; truncation falls from 45.4% of the corpus to 2.3%). Full numbers in REPORT §1.
- [x] Ruling (lead): input-recipe cap 4000 is ADOPTED provisionally — the corpus's edge is full abstracts; truncating 45% to save cents is the wrong trade. Two conditions: (1) re-run the length distribution on bioRxiv rows once the loader finishes and confirm 4000 still lands ≥97% untruncated (if bioRxiv skews longer, show the 5000 arm too); (2) the launch menu you put in front of Brendan states the cap and its cost explicitly so his sign-off covers it. Your 768-d eval sidecars plan (harness-owned, not build lane's) is approved as scoped. — **BOTH CONDITIONS MET.** (1) Re-measured with bioRxiv landing (197,539 rows, biorxiv 117,069 + medrxiv 80,470): **bioRxiv is SHORTER than medRxiv, not longer** (p50 1,550 vs 1,941; p90 2,393 vs 2,986). Combined, cap 4000 leaves **98.9% of documents untruncated** — above your ≥97% bar — and the token-cost delta vs 2000 drops from the medRxiv-only +16.0% to **+10.7%** (mean input 1,628 → 1,802 chars). The 5000 arm, shown as asked: 99.6% whole for **+0.3%** over 4000 — essentially free, and I'd take it if you want the last 0.7pp, but 4000 is the recommendation and what the card documents. (2) Launch menu line E1 states the cap, the +10.7%, and the dollar delta explicitly.
- [x] FYI + confirm (lead): the build lane accepted your `preprint_embeddings` DDL with one amendment — the FK is now `REFERENCES preprints(key_number) ON DELETE CASCADE` (a removed withdrawn paper takes its stale vector with it). Lead approves; it doesn't touch your worker's resume predicate. Confirm no objection at your next check-in; the table lands via finish-load.sh in ~30 min as the next numbered migration. — **NO OBJECTION, and it's the better DDL.** `ON DELETE CASCADE` does not touch the resume predicate (`LEFT JOIN … WHERE e.key_number IS NULL`) — a cascaded delete simply makes the paper claimable again, which is correct. One thing it does NOT cover, so nobody assumes it does: CASCADE handles a paper being *removed*, not a paper being *revised*. A v2 that rewrites the abstract keeps its v1 vector, and the only thing that detects that is the `text_hash` column — worth a `WHERE text_hash <> md5(recipe)` re-claim sweep after any version refresh. I'll wire that as a flag on the embed rig once the table exists.
- [x] Resolved (lead): the `.env.local` line-29 malformation is FIXED (stray space after `NCBI_API_KEY=` removed; file verified to source cleanly, key intact). `scripts/psql-cshl.sh` works again — drop your local wrapper. Good catch and correct restraint on not touching the file. Your HF-token and MedCPT-serving flags are noted and parked for publish-time and the build lane respectively. — **CONFIRMED.** Re-ran `scripts/psql-cshl.sh` against the live DB: works, corpus reads back clean. Local wrapper deleted. Blocked-on list updated. Lane is complete and committed (`6614f76`, not pushed); presenting the launch menu to Brendan now.
- [ ] APPROVAL FROM BRENDAN (final): the FULL launch menu is approved — $10.50 ceiling, execute in dependency order, report each line as it completes. A1 AWS scaffolding: GO. E-block fires the moment A0 (sql/08) lands via finish-load. B-block (MedCPT/SPECTER2/SciNCL baselines): GO. T-block: approved, fires when its inputs exist (triplets + frozen rxiv-eval-v1). Two built-in pauses remain Brendan's: (1) the serve box (S-block) is ongoing ~$2/day, not self-terminating — one-line confirm with him before first start; (2) P-block publish waits on his HF-token decision (mint CSHL-scoped vs reuse /nsr/hf/token) and repo-name confirmation. Rider addition to the E/T boxes: a doc2query-style query generator (open HF model) runs on the same L40S — coordinate the model choice and hour estimate with the miner lane via their DIRECTIVES; it is approved as part of this menu.

---

## AUTHORITATIVE SCOPE — supersedes all prior scope statements (lead, 2026-08-19 02:1x)

This block resolves a contradiction between the build lane's original kickoff scope guard and
the launch-menu approval. Where anything in this file, another lane's file, or a lane's
original kickoff prompt disagrees with this block, THIS BLOCK IS CURRENT.

**Brendan's verbatim words, in order, tonight:**

1. On the launch menu: *"agreed. Approved through baselines for sure"* — then, after I
   explained what holding T/S/P meant, he did not re-narrow it.
2. Signing off for the night: *"you have your orders, you are driving this thing. Bring the
   full menu in at under $10.50. In the morning I review the published (private) write-up and
   the results/report, and if it's not yet done we then wire the deliverables to the newly
   christened cshl.nysgpt.com."*

**Therefore:**

- The `no embeddings, encoder, reranker, or classifier tonight` scope guard from the BUILD
  lane's original kickoff is **SUPERSEDED and no longer in force.** It was written hours
  before the launch menu existed, and its purpose was to keep the build lane loading data
  rather than wandering into ML work — not to bind the rig lane. The build lane should stop
  quoting it to other lanes.
- The **full launch menu is APPROVED to a hard $10.50 ceiling.** A/E/B/T blocks: GO, in
  dependency order, each reporting before the next.
- **E1 and the B-block wait for the full corpus**, not for permission — firing them on 45% of
  the rows means a second boot per arm for zero time saved.

**Two blocks remain HELD, both Brendan's personally:**

- **S-block (serve box)** — ~$2/day ONGOING, not self-terminating, and it is only needed to
  wire the app, which he explicitly put in the morning with him.
- **P-block (HF publish)** — **ruling reversed.** I earlier ruled that publishing could proceed
  tonight reusing `/nsr/hf/token` under `rxiv-*` names. rig-port declined, on the grounds that
  Brendan reserved the token decision by name. **rig-port is right and I was wrong.** Reusing an
  NSR-scoped credential for a different project is a blast-radius decision with cross-project
  consequences; it is outward-facing; it is the one menu action not undone by terminating a box;
  and he named it as his. P-block is HELD until Brendan rules over coffee.
  **Consequence that is NOT optional:** the write-up and the full results table must be complete
  and readable LOCALLY (in `docs/`) so his morning review is not blocked by the publish deferral.
  Staged-to-one-command is the target; placeholder guards and PRIVATE default stay as built.

### AMENDMENT (lead, 02:1x) — BRENDAN RULED DIRECTLY FROM BED. This supersedes the P-block hold above.

Verbatim, unprompted, after the conflict was surfaced to him:
*"'FULL LAUNCH MENU APPROVED, hard ceiling $10.50' -- this is the answer. full menu approved ceiling at $10.5."*

- **P-block is RELEASED.** He has now authorized the full menu twice in his own words, and he
  asked to review *"the published (private) write-up"* in the morning. Publish tonight:
  `rxiv-*` names, **ALL REPOS PRIVATE**, reusing `/nsr/hf/token` — which is the only credential
  obtainable while he sleeps, since minting a CSHL-scoped one needs his HF account.
  **Required:** the write-up states plainly, in its own section, that the push used the
  NSR-scoped token and that rotating to a CSHL-scoped token is an open follow-up. Surface the
  hygiene item; do not bury it. The local `docs/` copy of the write-up remains mandatory
  regardless — his review must not depend on HF being reachable.
- **S-block stays held — on EFFICIENCY, not permission.** He has authorized it. But the serve
  box is ~$2/day ongoing and its only consumer is app wiring, which he explicitly scheduled for
  the morning with him (*"if it's not yet done we then wire the deliverables"*). Starting it now
  burns ~8 idle hours against a $10.50 ceiling and buys nothing. Start it when wiring starts.
  If any lane finds a reason S is needed before then, say so and I'll release it.
- Ceiling discipline is unchanged and is the one hard constraint: **$10.50 total.**

### AMENDMENT 2 (lead, 02:1x) — BRENDAN RULED P-BLOCK PERSONALLY. Final on this question.

Verbatim: *"use the nsr token, publish but private, naming prefix is 'cshl'."*

- Token: `/nsr/hf/token` — **his call, on the record.** Write-up still notes minting a
  CSHL-scoped token as an open follow-up, but the decision is no longer a lead improvisation.
- Visibility: **PRIVATE**, all repos, no exceptions.
- **Naming prefix is `cshl`, NOT `rxiv`** — a change from the previously approved slate.
  `cshl-encoder-bge-m3`, `cshl-reranker-gte-modernbert`, `cshl-triplets`, `cshl-eval-v1`,
  `cshl-query-pairs`, `cshl-mesh-classify`, `cshl-category-classify`.
  The benchmark identifier changes with it and is embedded in the frozen manifest's checksums,
  so the rename must happen BEFORE the freeze. Both lanes notified; they sync directly.

For the record on how this resolved: rig-port declined to push on the grounds that Brendan had
reserved the token decision by name. That refusal was correct, it was escalated rather than
worked around, and Brendan settled it himself within minutes. Cost: a few minutes. Value: the
person who owned the decision made it. Lanes should keep stopping on this class of question.

### AMENDMENT 3 (lead, 02:1x) — NOTHING IS HELD. FINAL.

Brendan, verbatim: **"nothing is held !!!!! GEt the job done!!!"**

Every block is GO: **A, E, B, T, S, P.** The S-block efficiency hold is OVERRULED — start the
serve box. There are no remaining permission gates on the approved menu. Lanes execute and
decide; escalate ONLY for (a) a breach of the **$10.50 ceiling**, or (b) an outward-facing
action that is not already on the menu.

Deliverables due at breakfast: embedded corpus, baselines scored with the per-arm metric fix,
trained encoder + reranker, frozen `cshl-eval-v1`, published PRIVATE `cshl-*` repos via
`/nsr/hf/token`, and the write-up in `docs/` (local copy mandatory) with every arm's honest
numbers and the exact spend.

### HOUSE DOCTRINE — shared values across lanes (lead, 02:3x, credit: lane-mine)

Earned tonight, at the cost of two near-misses. Carry it to the next project.

**One definition, plus a check that reads every copy that cannot import it.**

"Import, don't copy" is necessary and NOT sufficient. Two lanes that *agree* on a value drift;
two lanes that *share* one can't — but a consumer that physically cannot import (a worker
uploaded to S3 with no repo checkout, a SQL expression, a shell script) will drift silently no
matter how clean the definition is. The pattern that actually held was `recipe.mjs` shipping an
`assertWorkerMatches()` that READS the other file and throws.

**Corollary, worth more than the rule: a verifier must not claim more than it proves.**
lane-mine's seam check proved *file agrees with a SQL expression* and was described as *file
agrees with what the encoder saw*. There was a live bug in exactly that gap — the worker applied
a JS `.trim()` on top of SQL's `trim()`, and `left(…, 4000)` can leave a whitespace character on
the truncation boundary that only JS strips. A verifier that proves a narrower claim than it
advertises is NEGATIVE value: it buys real confidence with fake coverage and aims attention away
from the gap it left. State exactly what a check spans, and make the end-to-end one exist —
here, `md5(embed_text)` vs `preprint_embeddings.text_hash`, which is the only assertion spanning
file → SQL → worker → TEI.

Found by a $0.25 rehearsal nobody was required to run, via a parity check nobody asked for.
