---
license: mit
base_model: BAAI/bge-m3
library_name: sentence-transformers
pipeline_tag: feature-extraction
tags: [retrieval, biomedical, preprints, biorxiv, medrxiv, bge-m3]
---

# rxiv-encoder-bge-m3

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
| pairs | {{N_PAIRS}} |
| negatives / pair | {{N_NEGS}} |
| group size | {{GROUP_SIZE}} |
| query / passage max len | {{QUERY_MAX_LEN}} / {{PASSAGE_MAX_LEN}} tokens |
| batch / epochs / lr | {{BATCH}} / {{EPOCHS}} / {{LR}} |
| precision | bf16 |
| hardware / wall-clock | 1× NVIDIA L40S (g6e.xlarge), {{TRAIN_MINUTES}} min |

Supervision comes from {{SUPERVISION_SOURCES}}. Triplets are published separately
as `NYSgpt/rxiv-triplets`.

## Evaluation

Scored on the frozen `rxiv-eval-v1` benchmark (`NYSgpt/rxiv-eval-v1`), never on
training data. Baselines were measured on the **same** queries and the **same**
corpus, not quoted from their own papers.

| arm | R@1 | R@10 | nDCG@10 |
|---|---|---|---|
| BM25 / Postgres FTS | {{FTS_R1}} | {{FTS_R10}} | {{FTS_NDCG}} |
| stock `BAAI/bge-m3` | {{BGE_R1}} | {{BGE_R10}} | {{BGE_NDCG}} |
| `ncbi/MedCPT` | {{MEDCPT_R1}} | {{MEDCPT_R10}} | {{MEDCPT_NDCG}} |
| `allenai/specter2_base` | {{SPECTER_R1}} | {{SPECTER_R10}} | {{SPECTER_NDCG}} |
| `malteos/scincl` | {{SCINCL_R1}} | {{SCINCL_R10}} | {{SCINCL_NDCG}} |
| **this model** | **{{RXIV_R1}}** | **{{RXIV_R10}}** | **{{RXIV_NDCG}}** |
| RRF(FTS + this model) | {{RRF_R1}} | {{RRF_R10}} | {{RRF_NDCG}} |

Per-segment numbers (server, era, published vs unpublished, abstract length) are in
`results/` on the benchmark repo.

## Limitations

- English-only in practice, though the bge-m3 base is multilingual.
- Documents are truncated at 4,000 characters; the tail of a long methods-heavy
  abstract is not represented.
- Trained on preprint abstracts, not full text or figures.
- {{KNOWN_CAVEATS}}

## Usage

```python
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("NYSgpt/rxiv-encoder-bge-m3")
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
