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

- Status:
- 1 Embed rig:
- 2 Serve rig:
- 3 Train rig:
- 4 Eval harness + rxiv-eval-v1 draft:
- 5 Smoke test:
- 6 Publish rig:
- Launch menu (needs sign-off):
- Decisions needed:
- Blocked on:
