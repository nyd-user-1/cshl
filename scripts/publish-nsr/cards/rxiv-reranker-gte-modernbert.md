---
license: apache-2.0
base_model: Alibaba-NLP/gte-reranker-modernbert-base
library_name: transformers
pipeline_tag: text-ranking
tags: [reranker, cross-encoder, biomedical, preprints, biorxiv, medrxiv]
---

# rxiv-reranker-gte-modernbert

A cross-encoder reranker for **bioRxiv + medRxiv preprints**, fine-tuned from
[`Alibaba-NLP/gte-reranker-modernbert-base`](https://huggingface.co/Alibaba-NLP/gte-reranker-modernbert-base).
Takes `(query, document)` and returns a relevance logit. Used as the second stage
over a dense or hybrid top-K in RxivGPT.

## Training

| | |
|---|---|
| base | `Alibaba-NLP/gte-reranker-modernbert-base` |
| groups | {{N_GROUPS}} (1 positive + {{N_NEGS}} negatives each) |
| negatives mined from | {{NEG_SOURCE}} |
| epochs / max hours | {{EPOCHS}} / {{MAXHOURS}} |
| hardware / wall-clock | 1× NVIDIA L40S (g6e.xlarge), {{TRAIN_MINUTES}} min |

Negatives are mined from the retrieval space itself, not sampled at random — a
reranker trained against random negatives learns topicality, not ranking.

## Evaluation

Applied to the top-{{RERANK_POOL}} of a base arm on the frozen `rxiv-eval-v1`
benchmark. The number that matters is the **delta over the arm it reranks**, so it
is reported that way:

| base arm | base nDCG@10 | + this reranker | Δ |
|---|---|---|---|
| stock bge-m3 | {{BASE_BGE_NDCG}} | {{RR_BGE_NDCG}} | {{RR_BGE_DELTA}} |
| rxiv-encoder-bge-m3 | {{BASE_RXIV_NDCG}} | {{RR_RXIV_NDCG}} | {{RR_RXIV_DELTA}} |
| — vs `ncbi/MedCPT-Cross-Encoder` on the same pool | {{MEDCPT_CE_NDCG}} | | {{MEDCPT_CE_DELTA}} |

## Serving cost, honestly

Cross-encoding is per-candidate. On a CPU box the sibling NSR model measured
~0.13 s per candidate (top-50 ≈ 6.6 s), which is why reranking is **opt-in** rather
than default in the app. Always-on reranking wants a GPU or a hosted endpoint.
Measured here: {{RERANK_LATENCY}}.

## Limitations

- Query truncated to 600 characters, document to 900 — the app's own limits.
- Trained on abstracts; it has never seen a methods section.
- {{KNOWN_CAVEATS}}

<!-- Shared corpus/provenance block. Every card below includes this verbatim.
     Update ONE place when the corpus changes. Numbers marked {{...}} are filled
     from the actual load at publish time — scripts/publish-nsr/launch.sh refuses
     to publish a card that still contains {{ markers. -->

## Corpus

Both preprint servers operated by **Cold Spring Harbor Laboratory**:

| server | papers | posted range | with a published journal DOI |
|---|---:|---|---:|
| bioRxiv | {{BIORXIV_N}} | {{BIORXIV_RANGE}} | {{BIORXIV_PUBLISHED}} |
| medRxiv | {{MEDRXIV_N}} | {{MEDRXIV_RANGE}} | {{MEDRXIV_PUBLISHED}} |
| **total** | **{{TOTAL_N}}** | | **{{TOTAL_PUBLISHED}}** |

- **Source:** the public bioRxiv/medRxiv APIs (`api.biorxiv.org`, `api.medrxiv.org`),
  unauthenticated, harvested {{HARVEST_DATE}}. Field-by-field provenance and the
  endpoint inventory are in the project's `docs/prompts/LANE-RXIV-MAP.md`.
- **Unit of record:** a paper, not a version. A source row is a *version*; the hub
  keeps `max(version)` per `(server, doi)` and full history lives in a sidecar.
- **Business key:** the bare DOI suffix (`2026.07.31.741992`, `19000109`), which
  survives the 2026 DOI prefix change (`10.1101` → `10.64898`), with a
  `UNIQUE (server, doi)` collision guard.
- **Indexed text:** `left(trim(title || "\n\n" || abstract), 4000)` — abstract
  coverage on this corpus is ~100% (measured: 0 rows without an abstract), median
  1,941 characters, p99 4,763. The 4,000-character cap leaves ~2.3% of documents
  truncated; the NSR-inherited 2,000 cap would have truncated 45.4%.
- **Licensing:** preprint metadata and abstracts are redistributed by the servers
  under per-paper licenses ({{LICENSE_MIX}}). **Nothing in this repo redistributes
  full text.** Confirm CSHL's terms before flipping any repo public.

## Split discipline

25% of *papers* are held out by `md5("holdout:" || key_number)`, frozen before any
training, and the same hash rule is used by the benchmark builder, the encoder
triplet converter and the reranker group converter — so a held-out paper cannot
appear as a positive, a negative, or an anchor anywhere in training. The converters
audit what they **emit** (not what they read) and refuse to write a set that leaks.
