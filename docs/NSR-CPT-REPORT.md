# NSR-CPT — the night report (2026-08-16 → 17)

_Written by the lead session for Brendan to read on waking. Everything below is
measured unless marked estimate. Links are private HF repos under `NYSgpt`._

## TL;DR (read this first)

- **NSR-CPT exists.** Encoder + reranker trained tonight on NSR's expert keyword abstracts, evaluated on a frozen, held-out benchmark, and **published (private) on HF** with cards. All pre-registered gates passed.
- **Encoder** (`nsr-encoder-bge-m3`): vs stock bge-m3 on the benchmark — KW Recall@10 **.171 → .487 (+186 %)**, title-only papers **+262 %**, EX R@1 **.871 → .911**; better on every one of 16 segments. FTS+encoder fusion: KW R@1 **.344** (was .212).
- **Reranker** (`nsr-reranker-gte-modernbert`): re-scoring bge-m3's top-50 lifts KW R@1 **.080 → .180** (nDCG@10 +76 %), EX R@1 **.871 → .927**; better on every segment.
- **Stage 5 is live in prod (03:37):** search fuses FTS with *our* encoder over `nsr_embeddings_nsr`, chat retrieval and graph similarity follow; kill-switch `SEARCH_ENCODER=bge`; rollback tag `pre-stage5`. Reranker is opt-in (`&rerank=1`) because CPU latency.
- **Cost of the night:** ≈ $9 of credits one-off; `nsr-serve` t3.large ≈ $2/day while on. Neon floor restored to 0.25/4. Only `nsr-serve` (and your `44b-web`) are running.
- **Owed / next:** re-train on the clean triplets (removes the held-out-negatives caveat), reranker latency (GPU/HF endpoint), NNDC redistribution check before going public, Neon password rotation, LANE-PERF.

## What NSR-CPT is

A MedCPT-style retrieval stack for the Nuclear Science References corpus:
a fine-tuned dense **encoder**, a cross-encoder **reranker**, and a frozen
**benchmark** — trained not on click logs but on NSR's own expert-written keyword
abstracts (each one an NSR indexer describing a specific paper in canonical terms)
plus EXFOR experiment→paper links. Nobody else has this supervision signal.

## Deliverables (private on HF)

| # | Artifact | Where | Status |
|---|---|---|---|
| 1 | Frozen benchmark `nsr-eval-v1` (9,995 queries, qrels, baselines) | `datasets/NYSgpt/nsr-retrieval-benchmark` | **published** (commit 2b8fad7) |
| 2 | Training triplets (clean, full 152k anchors) | `datasets/NYSgpt/nsr-training-triplets` | **published** (clean full set, 151,912 pairs) |
| 3 | Encoder `nsr-encoder-bge-m3` (weights + card) | `NYSgpt/nsr-encoder-bge-m3` | **published** (2.27 GB safetensors, sha256 b429c81d…1d87d) |
| 4 | Reranker `nsr-reranker-gte-modernbert` (weights + card) | `NYSgpt/nsr-reranker-gte-modernbert` | **published** (598 MB safetensors; run 20260817-032126-train, TEI-compatible config) |
| 5 | Corpus embeddings — stock bge-m3 (`nsr_embeddings`) and **ours** (`nsr_embeddings_nsr`, 277,068 × 1024, HNSW) | Neon | live; S3 export is a daylight item |
| 6 | This report + lane REPORTs (`docs/prompts/LANE-*.md`) | repo | committed |

## The stages, what happened, what it cost

| Stage | What | Result | Wall-clock | Actual $ |
|---|---|---|---|---|
| 0 | Embed corpus with stock bge-m3 (277,068 docs, HNSW) | done earlier tonight (LANE-EMBED) | ~7 min GPU | $0.30 + rehearsal overshoot $0.62 |
| 0-read | Query encoder for stock bge-m3: Cloudflare Workers AI (free tier), parity cos ≥ .996 / identical top-10; `/api/search` on Neon replaces the retired Supabase path | live in prod | — | $0 |
| 1 | Frozen benchmark `nsr-eval-v1`: 4,998 KW + 4,997 EX queries, held out by paper, leak audit 0/0; baselines FTS / bge-m3 / RRF per segment | CLOSED — RRF best-or-tied; dense weakest on KW title-only (R@1 .05) | ~55 min | $0.79 (incl. $0.54 of a killed commercial arm) |
| 2 | Triplets: 152,006 anchors mined from our bge-m3 space + FTS, 8 negs/query, 2 % false-negative audit, split by paper; a first sweep leaked held-out papers as negatives (24.7 % of slots) → clean re-sweep with the holdout filter | COMPLETE — 151,912 pairs / 1.2M negs, 0 held-out anywhere | ~2 h incl. re-sweep | ~$0.30 (t4g.large) |
| 3 | Encoder: bge-m3 fine-tuned (FlagEmbedding, dense-only, group 8, q128/p256, bf16, batch 16, 1 epoch) on 39,568 pairs (all EX + stratified KW; the 60-min budget from measured 12.6 pairs/s) → re-embed corpus + eval queries with it, HNSW, score | **Gate 3 PASS**: KW R@10 +186 %, title-only +262 %, EX every segment ≥ | train 33.5 min; box 46.7 min total | $1.45 (+ $1.42 rehearsals/debug + $0.47 test box) |
| 4 | Reranker: gte-reranker-modernbert-base on 44b's trainer, same 39,600 groups, 2 epochs → rerank bge-m3 top-50 | first run trained clean (2,558 s) but the box terminated with weights un-uploaded (upload-order bug, fixed) → **re-run in progress** (re-run 032126: EXIT 0 in 1,283 s (2 epochs), weights + reranked results uploaded, **Gate 2 PASS**) | 43 min train ×2 | ≈ $1.7 ×2 + $0.19 rehearsals |
| 5 | Re-embed + cutover: `nsr_embeddings_nsr` serving table (our vectors, HNSW), `nsr-serve` TEI box (encoder :8080, reranker :8081, API key), `/api/search` fusion default + kill-switch `SEARCH_ENCODER`, dense arm in chat, `op=similar` in graph; GitHub tag `pre-stage5` = rollback | **LIVE 03:37** — prod `/api/search` serves fusion(FTS + **our encoder**) via `nsr-serve` (t3.large, TEI, API-key; parity vs stored vectors cos 1.00000, identical top-10), `op=similar` and chat's dense arm follow the same switch. Kill-switch: `SEARCH_ENCODER=bge` (+redeploy) returns to stock bge-m3 via Cloudflare instantly. Rollback tag `pre-stage5`. Reranker stage flips on (`SEARCH_RERANK=on`) only after Gate 2 | — | t3.large ≈ $0.083/h while on |
| 6 | Publish: private HF repos + cards + this report | **done** — 4 private repos under NYSgpt: `nsr-retrieval-benchmark`, `nsr-training-triplets`, `nsr-encoder-bge-m3`, `nsr-reranker-gte-modernbert`; this report committed | — | $0 |

## Results

### Stage 1 — baselines on `nsr-eval-v1`
See the benchmark card (`NYSgpt/nsr-retrieval-benchmark`) — reproduced in the encoder table below as arms A/B/RRF. Headline: KW R@1 FTS .161 / bge-m3 .080 / RRF .212; EX R@1 bge-m3 .871 / FTS .017.

### Stage 3 — encoder (Gate 3: beats raw bge-m3 on R@10 and nDCG@10 in every segment, ≥10% relative on blended KW)
**KW family — R@1 / R@10 / nDCG@10** (A = FTS, B = stock bge-m3, RRF = A+B, **D = nsr-encoder-bge-m3**, RRF-D = A+D)

| segment | n | A | B | RRF | **D** | RRF-D | D vs B R@10 |
|---|---:|---|---|---|---|---|---:|
| blended | 4,998 | 0.161 / 0.165 / 0.163 | 0.080 / 0.171 / 0.121 | 0.212 / 0.282 / 0.244 | **0.252 / 0.487 / 0.363** | 0.344 / 0.542 / 0.437 | +186% |
| richness:has-abstract | 857 | 0.160 / 0.162 / 0.161 | 0.222 / 0.383 / 0.296 | 0.317 / 0.455 / 0.380 | **0.422 / 0.631 / 0.527** | 0.495 / 0.678 / 0.585 | +65% |
| richness:title-only | 4,141 | 0.161 / 0.166 / 0.163 | 0.051 / 0.127 / 0.085 | 0.190 / 0.246 / 0.216 | **0.216 / 0.458 / 0.329** | 0.312 / 0.513 / 0.407 | +262% |
| era:pre1970 | 602 | 0.105 / 0.131 / 0.118 | 0.022 / 0.076 / 0.045 | 0.115 / 0.183 / 0.144 | **0.133 / 0.311 / 0.211** | 0.201 / 0.380 / 0.282 | +307% |
| era:1970-1999 | 2,686 | 0.181 / 0.183 / 0.182 | 0.067 / 0.152 / 0.105 | 0.220 / 0.281 / 0.249 | **0.259 / 0.507 / 0.376** | 0.363 / 0.565 / 0.458 | +233% |
| era:2000+ | 1,710 | 0.147 / 0.149 / 0.148 | 0.121 / 0.232 / 0.174 | 0.232 / 0.318 / 0.273 | **0.282 / 0.519 / 0.397** | 0.364 / 0.562 / 0.460 | +123% |
| reftype:journal | 4,250 | 0.159 / 0.164 / 0.161 | 0.087 / 0.179 / 0.129 | 0.216 / 0.288 / 0.249 | **0.263 / 0.495 / 0.372** | 0.352 / 0.548 / 0.445 | +176% |
| reftype:other | 748 | 0.168 / 0.174 / 0.171 | 0.039 / 0.120 / 0.075 | 0.189 / 0.246 / 0.217 | **0.187 / 0.447 / 0.310** | 0.297 / 0.503 / 0.396 | +271% |

**EX family — R@1 / R@10 / nDCG@10** (A = FTS, B = stock bge-m3, RRF = A+B, **D = nsr-encoder-bge-m3**, RRF-D = A+D)

| segment | n | A | B | RRF | **D** | RRF-D | D vs B R@10 |
|---|---:|---|---|---|---|---|---:|
| blended | 4,997 | 0.017 / 0.018 / 0.017 | 0.871 / 0.958 / 0.878 | 0.870 / 0.959 / 0.878 | **0.911 / 0.966 / 0.906** | 0.911 / 0.967 / 0.906 | +1% |
| richness:has-abstract | 448 | 0.011 / 0.011 / 0.010 | 0.578 / 0.862 / 0.689 | 0.583 / 0.864 / 0.693 | **0.752 / 0.940 / 0.822** | 0.761 / 0.946 / 0.830 | +9% |
| richness:title-only | 4,549 | 0.017 / 0.018 / 0.017 | 0.899 / 0.968 / 0.896 | 0.899 / 0.968 / 0.896 | **0.927 / 0.969 / 0.914** | 0.926 / 0.969 / 0.914 | +0% |
| era:pre1970 | 1,112 | 0.014 / 0.015 / 0.015 | 0.862 / 0.963 / 0.894 | 0.862 / 0.963 / 0.894 | **0.910 / 0.970 / 0.923** | 0.909 / 0.970 / 0.923 | +1% |
| era:1970-1999 | 2,368 | 0.024 / 0.025 / 0.024 | 0.891 / 0.962 / 0.885 | 0.891 / 0.962 / 0.885 | **0.919 / 0.963 / 0.903** | 0.918 / 0.963 / 0.903 | +0% |
| era:2000+ | 1,517 | 0.007 / 0.009 / 0.008 | 0.844 / 0.949 / 0.855 | 0.844 / 0.950 / 0.855 | **0.900 / 0.969 / 0.899** | 0.901 / 0.970 / 0.900 | +2% |
| reftype:journal | 4,665 | 0.016 / 0.017 / 0.016 | 0.875 / 0.962 / 0.887 | 0.875 / 0.962 / 0.886 | **0.916 / 0.970 / 0.914** | 0.915 / 0.971 / 0.914 | +1% |
| reftype:other | 332 | 0.024 / 0.027 / 0.022 | 0.801 / 0.904 / 0.753 | 0.807 / 0.907 / 0.758 | **0.840 / 0.913 / 0.792** | 0.849 / 0.916 / 0.798 | +1% |

**Gate 3 (pre-registered): D ≥ B on Recall@10 and nDCG@10 in every segment, ≥ 10 % relative on blended KW → PASS** (blended KW: R@10 +186 %, nDCG@10 +200 %; title-only R@10 +262 %). Fusion of FTS with the new encoder (RRF-D) is the strongest serving arm: KW R@1 .344 vs .212 with stock bge-m3.


### Stage 4 — reranker (Gate 2: reranked ≥ raw bge-m3 order in every segment, ≥10% relative on blended KW)
**KW family — R@1 / R@10 / nDCG@10** (raw = stock bge-m3 top-50 order; reranked = the same 50 re-scored by nsr-reranker-gte-modernbert)

| segment | n | raw bge-m3 | **+ reranker** | Δ nDCG@10 |
|---|---:|---|---|---:|
| blended | 4,998 | 0.080 / 0.171 / 0.121 | **0.180 / 0.241 / 0.213** | +76% |
| richness:has-abstract | 857 | 0.222 / 0.383 / 0.296 | **0.389 / 0.477 / 0.436** | +47% |
| richness:title-only | 4,141 | 0.051 / 0.127 / 0.085 | **0.136 / 0.193 / 0.167** | +96% |
| era:pre1970 | 602 | 0.022 / 0.076 / 0.045 | **0.090 / 0.128 / 0.107** | +137% |
| era:1970-1999 | 2,686 | 0.067 / 0.152 / 0.105 | **0.164 / 0.225 / 0.197** | +89% |
| era:2000+ | 1,710 | 0.121 / 0.232 / 0.174 | **0.236 / 0.307 / 0.274** | +58% |
| reftype:journal | 4,250 | 0.087 / 0.179 / 0.129 | **0.188 / 0.250 / 0.221** | +71% |
| reftype:other | 748 | 0.039 / 0.120 / 0.075 | **0.131 / 0.193 / 0.165** | +119% |

**EX family — R@1 / R@10 / nDCG@10** (raw = stock bge-m3 top-50 order; reranked = the same 50 re-scored by nsr-reranker-gte-modernbert)

| segment | n | raw bge-m3 | **+ reranker** | Δ nDCG@10 |
|---|---:|---|---|---:|
| blended | 4,997 | 0.871 / 0.958 / 0.878 | **0.927 / 0.967 / 0.912** | +4% |
| richness:has-abstract | 448 | 0.578 / 0.862 / 0.689 | **0.812 / 0.897 / 0.826** | +20% |
| richness:title-only | 4,549 | 0.899 / 0.968 / 0.896 | **0.938 / 0.974 / 0.920** | +3% |
| era:pre1970 | 1,112 | 0.862 / 0.963 / 0.894 | **0.920 / 0.970 / 0.926** | +4% |
| era:1970-1999 | 2,368 | 0.891 / 0.962 / 0.885 | **0.935 / 0.969 / 0.911** | +3% |
| era:2000+ | 1,517 | 0.844 / 0.949 / 0.855 | **0.918 / 0.961 / 0.901** | +5% |
| reftype:journal | 4,665 | 0.875 / 0.962 / 0.887 | **0.931 / 0.970 / 0.920** | +4% |
| reftype:other | 332 | 0.801 / 0.904 / 0.753 | **0.861 / 0.916 / 0.797** | +6% |

**Gate 2 (pre-registered): reranked ≥ raw on Recall@10 and nDCG@10 in every segment, ≥ 10 % relative on blended KW → PASS** (blended KW nDCG@10 +76 %, R@1 2.25×; EX R@1 .871 → .927). Candidate pools here are stock bge-m3's; in production the reranker sits on top of RRF(FTS + nsr-encoder).

**Serving note (measured 04:33):** on the t3.large CPU box the reranker costs ~0.13 s per candidate (10 → 1.4 s, 25 → 3.2 s, 50 → 6.6 s). It is therefore **opt-in in prod** (`/api/search?…&rerank=1`, top-20 pool, ~2–6 s) rather than default; always-on reranking wants a GPU or a HF Inference Endpoint. `SEARCH_RERANK=on` flips the default when that exists.

## Honest caveats (also in the model cards)
- The two training runs used the **partial** triplet mining (61.8 % of anchors, all EX) in which held-out benchmark papers could appear as *negatives* for other queries (24.7 % of negative slots). Query→positive was strictly disjoint; this is the standard DPR/MedCPT full-corpus mining setup, but the published `nsr-training-triplets` is the clean re-sweep (0 held-out anywhere) — a re-train on it is the obvious next run.
- Held-out papers with an exact-text twin (181 KW positives) score as hits; twins are also excluded as negatives.
- Cohere/commercial reference arm was killed at 6 % (throughput), so the table has no paid-API column.
- The encoder trained 1 epoch on 39.6k of 121.6k available pairs (a 60-min budget decision); more data/epochs is untested.
- Redistribution terms for keyword-abstract text (NNDC-authored) are unconfirmed → all HF repos private.
- Both models trained on the *same* 39,600-pair sample (`shared-39600`, selected by LANE-RERANK, used by LANE-TRAIN).

## Spend (actual)
| Item | Actual |
|---|---|
| Stage 0 embed (LANE-EMBED, earlier tonight) | $0.30 + $0.62 rehearsal overshoot |
| Stage 1 eval: query embeds $0.25 + killed Cohere arm $0.54 | $0.79 |
| Stage 2 mining: t4g.large ~2 h (incl. clean re-sweep) | ~$0.15 |
| Stage 3 encoder: 4 failed boots + debug ≈ $1.42, test box $0.47, training box 46.7 min $1.45 | ~$3.34 |
| Stage 4 reranker: rehearsals $0.19, lost run ≈ $1.6, re-run ≈ $1.6, duplicate box (killed) ~$0.15 | ~$3.5 |
| Stage 5/6: publisher t3.small ×2 (~$0.05), `nsr-serve` t3.large **ongoing $0.083/h ≈ $2/day** while on | ~$0.05 + serve |
| Neon: floor at 2/8 CU for the sweep + scoring (restore to 0.25/4 at close) | cents |
| **Night total (one-off)** | **≈ $9 of credits**; ongoing ≈ $2/day for `nsr-serve` until you swap it for a HF endpoint or stop it |

Quota requests filed (both `CASE_OPENED`, no reply yet): on-demand G 16→64 vCPU, Spot G 8→64.

## What's next (daylight)
1. **Re-train on the clean triplets** (`full-clean-0702`, 121,649 train pairs, zero held-out anywhere) — the disclosed caveat disappears; ~1 h GPU on the same rig (`MODE=train TRAIN_NAME=… scripts/train-nsr/launch.sh`), and try the full pair set / 2 epochs since the 60-min budget was a night constraint, not a quality one.
2. **Reranker on/off** — Gate 2 decides; `SEARCH_RERANK=on` in Vercel + `attach-reranker.sh` on `nsr-serve`.
3. **Serve latency** — first-time query embed is ~0.5–1 s on t3.large CPU; options: c7i-flex.xlarge (~2× at 2× cost), a HF Inference Endpoint (needs the `inference.endpoints` scope on the HF token — 2-minute dashboard task), or keep and rely on the caches (repeats ~0.2 s).
4. **Publish** — flip the four HF repos public once NNDC confirms keyword-abstract redistribution terms; then the NNDC email, benchmark table attached (doctrine).
5. **Cutover follow-through** — retire the OpenAI 256-d column + index (`nsr.embedding`, 46k rows), export `nsr_embeddings` (stock) to S3, LANE-PERF (Supabase off the client, `/references` 25 s → <1 s), rate limiting on `/api/*`.
6. **A second, CPU-cheap reranker arm** (`ms-marco-MiniLM-L6`, 44b's other model) if a smaller server matters.
7. **Rotate the Neon password** (it appeared in three S3 logs before the xtrace fix; logs redacted, bucket private) — one pass: Neon → SSM → Vercel env → `.env.local`.
