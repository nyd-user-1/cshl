---
license: mit
base_model: BAAI/bge-m3
library_name: sentence-transformers
pipeline_tag: feature-extraction
tags: [retrieval, biomedical, preprints, biorxiv, medrxiv, bge-m3]
---

# cshl-encoder-bge-m3

A dense retrieval encoder for **bioRxiv + medRxiv preprints**, contrastively
fine-tuned from [`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3).
1024-d, CLS pooling, normalized embeddings. Serves the dense arm of RxivGPT.

## What it is for

Query → preprint retrieval over the CSHL preprint corpus. It is a **domain
adaptation**, not a general-purpose upgrade: outside this corpus, use stock bge-m3.

## Training

| | |
|---|---|
| base | `BAAI/bge-m3` |
| objective | in-batch contrastive, dense only (`--unified_finetuning False`) |
| trainer | FlagEmbedding `finetune.embedder.encoder_only.m3` |
| pairs | 40,000 (of 132,793 available) |
| negatives / pair | 8 |
| group size | 8 |
| query / passage max len | 128 / 384 tokens |
| batch / epochs / lr | 4 (halved from 8 by the OOM loop on a 24 GB A10G) / 1 / 1e-5 |
| precision | bf16 |
| hardware / wall-clock | 1× NVIDIA L40S (g6e.xlarge), 141 min |

Supervision comes from citation-graph triplets only (`meta.family = CITE`, 100%) — cited work as positive, same-category-uncited (83%) and citation-of-citation (17%) as negatives. **Query-shaped training pairs existed and were not used; see Limitations.**. Triplets are published separately
as `NYSgpt/cshl-triplets`.

## Evaluation

Scored on the frozen `cshl-eval-v1` benchmark (`NYSgpt/cshl-eval-v1`), never on
training data. Baselines were measured on the **same** queries and the **same**
corpus, not quoted from their own papers.

| arm | R@1 | R@10 | nDCG@10 |
|---|---|---|---|
| BM25 / Postgres FTS | 0.047 | 0.081 | 0.063 |
| stock `BAAI/bge-m3` | 0.118 | 0.286 | 0.194 |
| `ncbi/MedCPT` | 0.235 | **0.457** | **0.337** |
| `allenai/specter2_base` | 0.153 | 0.351 | 0.247 |
| `malteos/scincl` | n/a | NOT RUN | n/a |
| **this model** | **0.157** | **0.332** | **0.237** |
| RRF(FTS + this model) | 0.237 | 0.472 | 0.345 |

Per-segment numbers (server, era, published vs unpublished, abstract length) are in
`results/` on the benchmark repo.

## Limitations

- English-only in practice, though the bge-m3 base is multilingual.
- Documents are truncated at 4,000 characters; the tail of a long methods-heavy
  abstract is not represented.
- Trained on preprint abstracts, not full text or figures.
- **This model does not beat `ncbi/MedCPT` and should not be presented as if it does** (MeSH R@10 0.332 vs 0.457, −27%). It also scores below `allenai/specter2_base` on MeSH (0.351). It beats its own base model `BAAI/bge-m3` by +16% on MeSH, which is close to the minimum acceptable outcome for an in-domain fine-tune rather than an achievement. Its demonstrated value is as a **fusion component**: `RRF(this + MedCPT + FTS)` = 0.472 MeSH R@10, the best arm measured — though plain BM25 contributes more to that fusion than this model does. Trained on citation-based document→document pairs and evaluated on query→document retrieval; that objective mismatch is the leading hypothesis for the shortfall and is directly testable against the 424,753 query-shaped pairs that were built and left unused.

## Usage

```python
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("NYSgpt/cshl-encoder-bge-m3")
v = m.encode(["CRISPR base editing off-target effects"], normalize_embeddings=True)
```

<!-- Shared corpus/provenance block. Every card below includes this verbatim.
     Update ONE place when the corpus changes. Numbers marked {{...}} are filled
     from the actual load at publish time — scripts/publish-nsr/launch.sh refuses
     to publish a card that still contains {{ markers. -->

## Corpus

Both preprint servers operated by **Cold Spring Harbor Laboratory**:

| server | papers | posted range | with a published journal DOI |
|---|---:|---|---:|
| bioRxiv | 345,882 | 2013-11-07 → 2026-08-18 | 176,056 (50.9%) |
| medRxiv | 87,567 | 2019-06-25 → 2026-08-18 | 39,352 (44.9%) |
| **total** | **433,449** | | **215,408 (49.7%)** |

- **Source:** the public bioRxiv/medRxiv APIs (`api.biorxiv.org`, `api.medrxiv.org`),
  unauthenticated, harvested 2026-08-19. Field-by-field provenance and the
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
## Licensing — measured, not assumed

Preprint metadata and abstracts are redistributed by the servers under **per-paper**
licences. This corpus is not uniformly permissive:

| licence | share | derivatives redistributable? |
|---|---:|---|
| `cc_by_nc_nd` | 35.1% | **no — no derivatives** |
| `cc_no` | 28.3% | **no — all rights reserved** |
| `cc_by` | 21.6% | yes |
| `cc_by_nc` | 8.1% | yes, non-commercial |
| `cc_by_nd` | 5.5% | **no — no derivatives** |
| `cc0` | 1.0% | yes |
| `cc0_ng` | 0.3% | yes |
| `unstated` | 0.1% | unknown |

`cc_no` means **all rights reserved**, not a Creative Commons licence — a prefix match on
`cc` reports the opposite of the truth, and did once before this table was generated from
the data.

**Nothing here redistributes full text**, only titles and abstracts as published by the
servers' public API. This repo is **private**. Making it public is a redistribution
decision about third-party content and is not ours to take unilaterally; the recommended
alternative is a keys-only release — every frozen row carries `doi` and `server`, so a
consumer can re-fetch text from `https://api.{server}.org/details/{server}/{doi}/na/json`.

Displaying abstracts in a search UI with attribution and a link to source is a *different*
question, and is what the public API exists for. The question here is bulk dataset
redistribution.

## Split discipline

25% of *papers* are held out by `md5("holdout:" || key_number)`, frozen before any
training, and the same hash rule is used by the benchmark builder, the encoder
triplet converter and the reranker group converter — so a held-out paper cannot
appear as a positive, a negative, or an anchor anywhere in training. The converters
audit what they **emit** (not what they read) and refuse to write a set that leaks.
