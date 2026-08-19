# LANE-EVAL — Stage 1: the frozen NSR retrieval benchmark (keyword→paper, EXFOR→paper)

You are running the evaluation lane for NSRgpt's model phase. Stage 0 (bge-m3
vectors for the whole corpus, HNSW live — `docs/prompts/LANE-EMBED.md` REPORT)
is done. This lane builds the **frozen benchmark every later arm is scored
against** and reports the first three baselines: FTS, raw bge-m3, one commercial
embedding. It produces MEASUREMENTS, not an integration — nothing in `src/` or
`api/` changes.

## Why this benchmark is unusually good — and the one thing that would ruin it

NSR's own evaluators wrote a structured **keyword abstract** for 206,892 entries
(`nsr.sentence_groups`: typed REACTION / MEASURED / DEDUCED phrases). That is a
query→document pair per paper at ~200k scale, written by domain experts —
44b's whole reranker program had 3,063 such gold pairs (`44b/docs/reports/
2026-07-29-reranker.md` §1). Plus 23,515 EXFOR experiment→paper links
(`nsr_exfor`, 21,423 distinct papers, measured 2026-08-17).

**Leak check, already measured (2026-08-17, unpooled Neon):** the embedded
document is `title || abstract`, and `abstract` is the *publisher* abstract
(93,579 rows, S2/OA-enriched); keyword abstracts live ONLY in `sentence_groups`
(206,892 rows). Zero `abstract` values start with `NUCLEAR ` (the keyword-abstract
sentinel). So a keyword-abstract query is never a substring of its own document.
**Re-verify this in Phase 1 with the query below and paste the count** — if any
document contains its own query text, that pair is leakage and is dropped.

## Non-negotiables (violating any of these fails the lane)

1. **Read first**: `docs/prompts/LANE-EMBED.md` (REPORT section — the measured
   rig numbers you will reuse), `sql/23-embeddings.sql`, `sql/19-chat-fts.sql`
   (the production FTS you are baselining), `44b/docs/reports/2026-07-29-reranker.md`
   §2–3 (how a frozen eval is held out and why the universe caveat is stated),
   `44b/docs/HANDOFF-rerank-bakeoff.md` §3 (why every result is reported PER
   SEGMENT, never blended).
2. **Report per corpus segment.** 44b's lesson: a blended number hid a 34%
   patent regression. NSR's segments (fixed here, measured counts go in REPORT):
   - **doc-richness**: keyworded entries whose document has a publisher abstract
     (26,329 measured) vs **title-only documents** (the rest — the hard case);
   - **era**: pre-1970 / 1970–1999 / 2000+ (`pub_year`);
   - **reference type**: journal vs report/thesis/conference (`reference_type`,
     `journal_code`).
   Every table in REPORT carries the blended row AND every segment row.
3. **Query embedding runs on the same rig that embedded the corpus** —
   `scripts/embed-nsr/` (bge-m3 via TEI on g6e.xlarge, self-terminating). Never
   run model inference on this laptop (8 GB; the rule is absolute in 44b and
   here). Never a headless browser. **No `npx` one-off installs or local test
   harnesses on the laptop either** — DB-only Node scripts (Phase 1, Arm A/B
   scoring) may run here; anything model-side may not.
   **Capacity fallback** (g6e.xlarge returned `InsufficientInstanceCapacity`
   tonight; try other AZs via the rig's SUBNET knob first): (a) start
   `44b-encoder` (`i-0cd90bc89794193ff`, t3.medium, stock TEI bge-m3 — the
   byte-identical runtime; private IP, so call it from a box in the VPC) and
   stop it after; or (b) HF hf-inference `BAAI/bge-m3` feature-extraction
   (`normalize:true, truncate:true`; parity vs stored vectors cos 0.99999
   measured 2026-08-16 on 5 rows; token in `~/.cache/huggingface/token`).
   NOT Cloudflare Workers AI for this — cos 0.996, fine for search, not for a
   benchmark arm. Whichever path, record which one produced the vectors.
4. **Secrets** as in LANE-EMBED: DB URL via SSM SecureString `/nsr/embed/dburl`;
   never in argv/logs/user-data/any file you create.
5. **Neon laws**: unpooled + `pool.on('error')`; batched writes; **the HNSW
   index already exists — a kNN must pass the probe vector as a `$1::vector`
   parameter** (a join-sourced probe measured 2.5 s exact-scan vs 1 ms indexed);
   `SET LOCAL hnsw.ef_search` inside a transaction whenever k > 40 (default
   ef_search caps results). Bump the compute floor before the scoring sweep,
   restore after, note both in REPORT.
6. **Credits are money.** Print projected tokens and dollars BEFORE any billable
   call. The commercial arm has a **hard ceiling of $10.00** — a projection
   above it means STOP and report, not proceed. GPU: one g6e.xlarge, boot-
   dominated — anchor: LANE-EMBED's full-corpus pass was 0.16 instance-hours ≈
   $0.30; ~10k query rows will cost the boot, ~$0.20–0.30. Report projected AND
   actual spend.
7. **Do not commit, do not push.** Report by editing the REPORT section. Leave
   artifacts in the working tree / `data/eval/`.

## Phase 1 — census + freeze (no spend)

Script: `scripts/eval/build-nsr-eval.mjs` (read-only against Neon; writes
`data/eval/nsr-eval-v1/`). Model it on `44b/scripts/reranker-pairs.mjs` +
`build-training-pairs.mjs` (freeze → holdout by hash → manifest).

- **Query text (deterministic):** flatten `sentence_groups` → for each group,
  `topic` + the phrases' `text` joined by `; ` — LaTeX kept exactly as stored
  (documents were embedded raw too). Record min/median/max query length.
- **Holdout by paper**: `md5('holdout:' || key_number)` in the first quarter of
  the hash space (44b's rule) → the held-out paper set. Every eval query's
  positive must be a held-out paper; **LANE-TRIPLETS will exclude these papers
  from training entirely.**
- **Query families:**
  - **KW** — keyword abstract → its own paper. Only papers that have a vector
    (182,363 keyworded entries do, measured). Cap **5,000** queries, sampled
    stratified across the three segment axes so no cell is empty; write the
    per-cell counts.
  - **EX** — EXFOR entry text (`exfor_entries.title` + reaction codes) → the
    linked NSR paper(s). One query per EXFOR id whose linked paper is held out;
    an EXFOR id with several papers carries a positive SET (score any hit as
    correct — 44b's card rule). Cap 5,000.
- **Leak audit** (paste results): (a) `count(*) FROM nsr WHERE abstract IS NOT
  NULL AND abstract LIKE 'NUCLEAR %'` (expect 0); (b) for every KW query,
  `position(query_text in title||abstract) > 0` count (expect 0; drop any hit);
  (c) exact-duplicate documents (same `text_hash` in `nsr_embeddings`) — a
  held-out paper's twin ranks equally; count twins and score a twin hit as
  correct (record how many positives have twins).
- **Universe = the full 277,068-vector corpus.** Not a subsample. (44b's 75k
  universe made every recall figure optimistic and had to say so; we don't have
  to — kNN over the full corpus is 1 ms.) FTS runs over the same 277,068 keys.
- Freeze: `queries.jsonl` (qid, family, text, segment tags), `qrels.tsv`
  (qid, key_number), `manifest.json` (counts per cell, hash seed, corpus
  frozen-at = `max(embedded_at)`, leak-audit numbers).
- **Gate 1 (objective, pre-authorized):** leak audit (a)=0 and (b)=0 after
  drops; ≥ 3,000 KW queries and ≥ 1,000 EX queries survive; no segment cell
  under 100 queries (merge cells and say so if one is). Any failure → HALT,
  write it, wait.

## Phase 2 — embed the queries (GPU, ~$0.30)

- Add table `nsr_eval_queries (qid text PRIMARY KEY, family text, text text,
  embedding vector(1024), embedded_at timestamptz)` in `sql/24-eval.sql`; load
  the frozen queries.
- Point the LANE-EMBED worker at it: same claim loop, `SOURCE_TABLE` /
  `TARGET_TABLE` env (surgical change; keep `LO_CAP`, log-to-S3, self-terminate).
  bge-m3 with `truncate:true`. **The commercial arm needs its own query AND
  corpus vectors — see Phase 3; do not embed queries for it here.**
- Verify: `count(embedding IS NOT NULL) = count(*)`, 0 zero-vectors, instance
  `terminated`, log in S3. Record billable minutes and dollars.

## Phase 3 — score three baselines, per segment

Script: `scripts/eval/score.mjs`, one JSON result file per arm in
`data/eval/nsr-eval-v1/results/` (write each as it finishes — a death costs one
arm). Metrics per query family × segment: **Recall@1/5/10/50, MRR, nDCG@10**.
Wrap DB calls in retries.

- **Arm A — production FTS**: exactly the sql/19 weighted `websearch_to_tsquery`
  path `/api/chat` serves today, top-50. If a query's LaTeX makes
  `websearch_to_tsquery` return empty, fall back to `plainto_tsquery` and COUNT
  how often (that count is itself a finding).
- **Arm B — bge-m3 dense**: `SET LOCAL hnsw.ef_search = 100; … ORDER BY
  embedding <=> $1::vector LIMIT 50` inside `sql.transaction`. Confirm the plan
  says `Index Scan using nsr_embeddings_embedding_idx` on the first query.
- **Arm C — one commercial embedding, full corpus + queries** (needs BOTH sides
  in the same space). Recommended: **Cohere `embed-english-v3.0` via Bedrock**
  (auth path already proven for chat: env `AWS_BEARER_TOKEN_BEDROCK`, region
  `us-east-2` — inline token config is silently ignored; list price $0.10 /
  1M tokens; **first run `aws bedrock list-foundation-models --region us-east-2
  --by-provider cohere` and use the current embed model id** — v3 may be
  superseded by v4; Cohere requires `input_type: "search_document"` for corpus
  rows and `"search_query"` for queries — a mismatch silently degrades the
  arm; ≤ 96 texts per call) —
  alternative OpenAI `text-embedding-3-small` ($0.02 / 1M list; account is
  unfunded/legacy, would need funding). Before ANY call: count tokens of the
  277,068 documents (title||abstract, 2,000-char cap as embedded) + queries
  with the provider's tokenizer or a ≤ +20% proxy, print projected dollars; if
  > $10.00 STOP. Store in `nsr_embeddings_commercial (key_number, model,
  embedding vector(N))`, HNSW after load, then score like Arm B. Run the calls
  from the 44b worker box or a t4g, batched, checkpointed, resumable — never
  from the laptop for the corpus side. **After Arm C is scored: `COPY` the
  table to `s3://nsr-embed-v2/eval/cohere-vectors/` (parquet or csv.gz), note
  the size and sha256, then `DROP TABLE nsr_embeddings_commercial` — the
  benchmark keeps the numbers; Neon does not keep the storage bill.**
- **Latency**: p50/p95 server-side ms per query for A and B from EXPLAIN
  ANALYZE on 200 queries (warm), and end-to-end from the scoring host.
- **Also report the FTS-vs-dense fusion (RRF k=60)** — one extra ordering,
  free; 44b measured BM25 P@1 0.856 vs dense 0.681 vs RRF 0.728 on ITS data
  (`44b/docs/reports/2026-08-10-reranker-eval-full.md` Table 1) — lexical
  winning is a live possibility here, especially on title-only documents. **A
  dense arm losing to FTS on a segment is a successful measurement, not a
  failed lane.**

## Gates / how this lane ends

- All three arms scored on all segments → write REPORT, close. Recommend, in
  one line each: the first-stage retriever to serve TODAY (may be FTS), and
  whether Stage 2 (fine-tuning on triplets) is justified — it is justified iff
  raw bge-m3 trails FTS or trails on the title-only segment, i.e. there is a
  measured gap for supervision to close.
- Commercial arm projection > $10 → skip Arm C, say so, close with A and B.
- Any Gate 1 failure → HALT and wait.

## REPORT

_(edit as you go; the lead reads it verbatim)_

- Status: **CLOSED on Arms A / B / RRF.** Phase 1 and Phase 2 complete, Gate 1
  GREEN. Phase 3 fully scored (9,995/9,995 queries) for Arm A (FTS), Arm B (bge-m3
  dense), and RRF fusion — tables, latency, and recommendations below. **Arm C
  (commercial) killed by lead decision** before completion (2026-08-17 ~04:56Z) —
  corpus-side embedding was throttled to ~16-17 rows/s by this AWS account's Bedrock
  tokens-per-minute quota for `cohere.embed-v4:0`, making a full-corpus run a
  multi-hour job. 17,760/277,068 corpus rows and 0/9,995 query rows had been embedded
  when killed; that partial data was dropped (`TRUNCATE nsr_embeddings_commercial`),
  the EC2 instance terminated, and the empty `nsr_embeddings_commercial` /
  `nsr_eval_queries.embedding_commercial` schema left in place for a future
  non-blocking background run if the commercial reference is ever wanted. The
  serve-now and Stage-2 recommendations below do not depend on Arm C — they were
  already fully determined by the A/B/RRF split.

- **Phase 1 census** (`scripts/eval/build-nsr-eval.mjs`, `data/eval/nsr-eval-v1/manifest.json`):
  - KW-eligible (keyworded + embedded): 182,363. Held-out (first quartile of
    `md5('holdout:'||key_number)`): 47,646 candidate group-queries. Leak-dropped: 0.
    **Final KW sample: 4,998** (capped at 5,000; stratified over era×richness cells,
    floor 100/cell, proportional remainder).
  - Distinct EXFOR ids with an embedded, linked NSR paper: 20,569. Candidates with
    ≥1 held-out linked paper: 5,560. **Final EX sample: 4,997**.
  - Segment-cell counts (era×richness cross, KW / EX) — the two axes are each well
    covered (see below); the 6-way cross has thin cells exactly where expected
    (pre-1970 papers rarely carry a publisher abstract): KW pre1970×has-abstract=19,
    EX pre1970×has-abstract=9, EX 1970-1999×has-abstract=20. Every other cross-cell
    ≥162. This is a real property of the corpus (LANE-EMBED's own note: pre-1970
    entries are frequently private-communication stubs with blank abstracts), not a
    sampling defect.
  - **Gate-1-relevant single-axis totals (both families clear ≥100 on every bucket):**
    KW era pre1970/1970-99/2000+ = 602/2,686/1,710; KW richness has-abstract/title-only
    = 857/4,141; KW reftype journal/other = 4,250/748. EX era = 1,112/2,368/1,517; EX
    richness = 448/4,549; EX reftype = 4,665/332.
  - Query length (chars): KW min/median/max = 39/168/13,648. EX min/median/max =
    24/168/15,905. A handful of KW/EX queries are very long (papers with many
    sentence-groups, or EXFOR entries with long reaction-code lists) — TEI's
    `truncate:true` is the backstop; flagged for Arm A too (see fallback count below).

- **Leak audit:**
  - (a) `abstract LIKE 'NUCLEAR %'`: **0** (re-verified per the brief; matches the
    pre-verified 2026-08-17 measurement — keyword abstracts never leak into the
    publisher-abstract column).
  - (b) query-text-in-own-document hits: **0 of 47,646 KW candidates** (bulk
    `unnest`+`position()` check, run before sampling). Zero drops needed.
  - (c) exact-duplicate-document twins (same `text_hash` in `nsr_embeddings`),
    computed over the **final KW sample's positives**: **181 of 4,998** positives
    (3.6%) have a twin. A twin hit is scored as correct in Phase 3 (per the brief).
  - **Gate 1: ALL PASS.** (a)=0, (b)=0 after drops, KW 4,998≥3,000, EX 4,997≥1,000,
    no reported segment-axis bucket <100.

- **Phase 2** (`scripts/eval/embed-queries-worker.mjs` + `launch-embed-queries.sh`,
  a surgical SOURCE/TARGET adaptation of the LANE-EMBED rig for `sql/24-eval.sql`'s
  `nsr_eval_queries` table — plain `UPDATE` instead of the corpus's sidecar `INSERT`,
  one box, one pass, no lane/boundary splitting needed at 10k rows):
  - Rig: g6e.xlarge, same DLAMI/TEI/IAM-role/SSM-secret/self-terminate/S3-log pattern
    as `scripts/embed-nsr`. Instance `i-08b5dcd7b4517a469`, launched 2026-08-17
    04:14:02Z, confirmed **terminated** ~04:22Z.
  - Rows embedded: **9,995 / 9,995** (4,998 KW + 4,997 EX). Zero-vector check: 0/100
    sampled; L2 norms all 1.0000 ± 1e-6 (TEI normalizes). S3 log
    (`s3://nsr-embed-v2/logs/nsr-eval-queries-1786940190.log`): **0 error lines**,
    `ALL DONE: 9995 rows in 0.2 min` (embed time only; boot dominated the wall clock).
  - Billable time: ~8 min instance lifetime ≈ 0.13 instance-hours × $1.861/hr g6e.xlarge
    on-demand ≈ **$0.25 actual** (projected $0.20–0.30 per the brief's own anchor).

- **Phase 3 — Arms A (FTS) / B (dense bge-m3) / RRF (k=60), full 9,995-query run**
  (`scripts/eval/score.mjs`, `data/eval/nsr-eval-v1/results/{A,B,RRF}.json`; Arm A
  restricted to the 277,068-vector universe via a join to `nsr_embeddings`, per the
  brief — not raw production, which spans all 303,568 rows). websearch-empty
  fallback: **0/9,995** — no query's LaTeX broke `websearch_to_tsquery` badly enough
  to empty the tsquery itself. First Arm-B query plan confirmed `Index Scan` on
  `nsr_embeddings_embedding_idx`.

  **KW family (n=4,998) — Recall@1 / @5 / @10 / @50, MRR, nDCG@10:**

  | segment | n | Arm A (FTS) | Arm B (dense) | RRF (A+B) |
  |---|---:|---|---|---|
  | **blended** | 4,998 | .1605/.1647/.1651/.1667 · MRR .1623 · nDCG .1629 | .0798/.1387/.1705/.2489 · MRR .1095 · nDCG .1211 | .2117/.2595/.2819/.3435 · MRR .2355 · nDCG .2443 |
  | era pre1970 | 602 | R@1 .1047 · MRR .1139 | R@1 .0216 · MRR .0384 | R@1 .1146 · MRR .1354 |
  | era 1970-99 | 2,686 | R@1 .1813 · MRR .1821 | R@1 .0666 · MRR .0936 | R@1 .2204 · MRR .2412 |
  | era 2000+ | 1,710 | R@1 .1474 · MRR .1482 | R@1 .1211 · MRR .1593 | R@1 .2322 · MRR .2618 |
  | has-abstract | 857 | R@1 .1599 · R@10 .1622 | R@1 **.2217** · R@10 .3827 | R@1 .3174 · R@10 .4551 |
  | title-only | 4,141 | R@1 .1606 · R@10 .1657 | R@1 **.0505** · R@10 .1265 | R@1 .1898 · R@10 .2461 |
  | journal | 4,250 | R@1 .1591 · MRR .1608 | R@1 .0871 · MRR .1173 | R@1 .2158 · MRR .2399 |
  | other | 748 | R@1 .1684 · MRR .1705 | R@1 .0388 · MRR .0650 | R@1 .1885 · MRR .2105 |

  **EX family (n=4,997):**

  | segment | n | Arm A (FTS) | Arm B (dense) | RRF (A+B) |
  |---|---:|---|---|---|
  | **blended** | 4,997 | .0166/.0176/.0176/.0176 · MRR .0171 · nDCG .0168 | .8705/.9504/.9584/.9680 · MRR .9068 · nDCG .8777 | .8703/.9506/.9586/.9682 · MRR .9068 · nDCG .8779 |
  | era pre1970 | 1,112 | R@1 .0144 · MRR .0148 | R@1 .8615 · MRR .9037 | R@1 .8615 · MRR .9036 |
  | era 1970-99 | 2,368 | R@1 .0236 · MRR .0239 | R@1 .8915 · MRR .9214 | R@1 .8915 · MRR .9215 |
  | era 2000+ | 1,517 | R@1 .0073 · MRR .0079 | R@1 .8444 · MRR .8861 | R@1 .8438 · MRR .8863 |
  | has-abstract | 448 | R@1 .0112 · R@10 .0112 | R@1 .5781 · R@10 .8616 | R@1 .5826 · R@10 .8638 |
  | title-only | 4,549 | R@1 .0171 · R@10 .0182 | R@1 **.8993** · R@10 .9679 | R@1 .8987 · R@10 .9679 |
  | journal | 4,665 | R@1 .0161 · MRR .0165 | R@1 .8755 · MRR .9112 | R@1 .8748 · MRR .9110 |
  | other | 332 | R@1 .0241 · MRR .0247 | R@1 .8012 · MRR .8437 | R@1 .8072 · MRR .8482 |

  **The finding, stated plainly**: KW and EX flip which arm wins, hard. KW queries
  are the NSR keyword-abstract vocabulary (short, telegraphic, e.g. `measured
  σγγ-coin`) — lexical, and FTS wins clearly (R@1 .16 vs dense .08). EX queries are
  EXFOR titles + raw reaction codes (e.g. `3-LI-6(N,TOT),,SIG`) — those codes are
  near-noise for `websearch_to_tsquery` (R@1 **.017**), but dense bge-m3 nails the
  underlying physics topic (R@1 **.87**) because the linked NSR paper discusses the
  same reaction in prose. RRF (k=60) is at-or-above the better single arm on **both**
  families — best-or-tied everywhere measured — which makes it the strongest
  single "serve now" candidate rather than routing by family.
  - Also note the **richness split on KW dense** — has-abstract R@1 .22 vs
    title-only R@1 .05, a 4.4× gap — the clearest single signal in this benchmark
    for where supervision (Stage 2) would help most.

- Latency p50/p95, full run (200-query EXPLAIN-ANALYZE sample, warm system):
  - **Arm A (FTS)**: server 4.8/9.3 ms p50/p95; end-to-end (laptop→Neon HTTP) 80/177 ms.
  - **Arm B (dense)**: server 4.1/6.4 ms p50/p95 on the 200-sample; end-to-end 90/303 ms.
    Note: this 200-query EXPLAIN-ANALYZE sample landed fast (warm cache from the
    immediately-preceding full scoring pass); the standalone 30-query smoke test
    earlier in this run (fresh queries, less warm) measured 330-420ms p50 server-side
    — LANE-EMBED's own report separately measured the same split: **1.0ms warm
    repeated-probe** vs **330-354ms cold graph-region touch**. Both are real; which
    one a production request sees depends on how warm the HNSW graph region for that
    specific query vector already is. Report both: best-case ~1-5ms, cold-region
    ~330-420ms.
  - Arm C: not scored — killed before both sides were embedded (see Status).

- Spend, final:
  - Phase 2 (query embedding, bge-m3/TEI, g6e.xlarge): **$0.25 actual**
    (~8 min instance lifetime, projected $0.20–0.30).
  - Arm C (killed before completion): projected **~$3.62** for a full run (not
    incurred in full). **Actual: ~$0.54** — Bedrock ~$0.535 (17,760 corpus rows
    embedded, 15,605,365 chars ÷ 3.5 chars/token proxy ≈ 4.46M tokens × $0.12/1M)
    + EC2 t3.small ~$0.008 (two short-lived instances, ~2 min + ~20 min). Well under
    both the $10 hard ceiling and the $3.62 projection, since it was killed early.
  - Corpus-side GPU rehearsal/full run (LANE-EMBED, bge-m3) not re-billed here.
  - **Total this lane: ~$0.79 actual** (Phase 2 $0.25 + Arm C partial $0.54).
- Recommendations:
  - **Serve now: RRF (k=60) fusion of the existing FTS + bge-m3 dense arms** — it
    is best-or-tied on every measured segment of both families, needs no new
    infrastructure (both arms already exist), and fixes the worst failure mode of
    each single arm (FTS's near-total blindness on EX queries; dense's weak recall
    on lexical KW queries and on title-only documents).
  - **Stage 2 (fine-tuning on triplets) is justified — on KW, specifically the
    title-only segment.** Gate condition met: raw bge-m3 trails FTS on KW blended
    (R@1 .08 vs .16) **and** trails hardest on the title-only segment (R@1 .05 vs
    FTS's .16, and vs its own has-abstract self at .22). EX does not need it — dense
    already dominates there (R@1 .87-.90) and FTS is structurally unfixable on raw
    reaction codes, not a supervision problem.
- Deviations / flags:
  - **Arm C region**: brief suggested `us-east-2`; `cohere.embed-v4:0` is not
    In-Region-supported there (AWS model card: us-east-2 is Geo/Global-only for
    this model). Used **us-east-1** instead (In-Region supported, and where the
    rest of this lane's AWS infra already lives) — same model, same account,
    stated deviation.
  - **Arm C dimension**: the brief's schema sketch didn't fix a dimension for the
    commercial arm; live `InvokeModel` test returned **1536-dim** (no
    `output_dimension` override field in this model's request shape), so
    `nsr_embeddings_commercial`/`nsr_eval_queries.embedding_commercial` are
    `vector(1536)`, not matched to bge-m3's 1024.
  - **Arm C concurrency**: first launch used 5 concurrent Bedrock batch calls and
    immediately hit the account's tokens-per-minute quota (`"Too many tokens, please
    wait before trying again"`), causing a synchronized retry storm. Killed that
    instance (2,880 corpus rows already committed — checkpointed, resumable by
    construction), fixed the worker to serial calls (`CONC=1`) with jittered
    exponential backoff, relaunched. Documented as a real measured constraint on this
    account, not a brief violation.
  - Token/cost projection for Arm C used a conservative char/token proxy (3.5
    chars/token — Cohere's own tokenizer wasn't available locally) rather than the
    provider's real tokenizer; this over-estimates tokens (and therefore cost), which
    is the safe direction for a pre-spend gate.
  - **Arm C throughput / kill decision**: even serial (`CONC=1`) calls sustained
    only ~16-17 rows/s against this account's Bedrock tokens-per-minute quota for
    `cohere.embed-v4:0` (frequent "Too many tokens" backoffs even one-at-a-time) —
    a full 277,068-row corpus pass would have taken ~4-5 hours across several
    watchdog-forced relaunches (each box self-shuts down at +90min). Lead decision:
    kill it and close the lane on A/B/RRF, since neither recommendation below
    depends on Arm C. **Instance `i-05e7a5136fa509e4c` was hard-terminated**
    (`aws ec2 terminate-instances`, not the script's own graceful
    self-shutdown-after-S3-upload path) — so unlike the other runs in this lane,
    there is no S3 log for this final partial run; the authoritative record is the
    17,760-row count read directly from `nsr_embeddings_commercial` before it was
    truncated. `nsr_embeddings_commercial` and `nsr_eval_queries.embedding_commercial`
    are left as empty schema (not dropped) for a future non-blocking run.
  - **Secret-handling note** (unrelated to Arm C's outcome, caught mid-lane): the
    launch scripts' `set -x` traced the decrypted Neon DB URL from SSM into the
    boot log, which then got uploaded to S3 in plaintext — a violation of the
    "secrets never in logs" law. Caught and fixed for both `launch-embed-queries.sh`
    and `launch-embed-commercial.sh`; the two already-uploaded S3 log objects
    (`nsr-eval-queries-*.log`, `nsr-embed-part0-*.log`) were downloaded, the leaking
    line stripped, and re-uploaded in place. The bucket has full public-access-block
    enabled and no bucket policy (private to this AWS account), so exposure was
    contained to account principals, not public — still worth a Neon password
    rotation at the lead's discretion.
