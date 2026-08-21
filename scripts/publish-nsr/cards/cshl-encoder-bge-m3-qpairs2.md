---
license: mit
base_model: BAAI/bge-m3
library_name: sentence-transformers
pipeline_tag: feature-extraction
tags: [retrieval, biomedical, preprints, biorxiv, medrxiv, bge-m3, dense-retrieval, CSHL-CPT]
language: [en]
---

# cshl-encoder-bge-m3-qpairs2

The **CSHL-CPT retriever**: `BAAI/bge-m3` fine-tuned on 100,000 mined query→paper
pairs from every bioRxiv and medRxiv preprint. Dense, 1024-d, cosine, normalized.
Supersedes [`cshl-encoder-bge-m3-qpairs`](https://huggingface.co/NYSgpt/cshl-encoder-bge-m3-qpairs)
(same recipe, 40k pairs) and is the encoder serving RxivGPT.

**Story in one line:** `ncbi/MedCPT` learned retrieval from ~255 million real PubMed
search-click pairs; this model learned it from 100,000 pairs mined out of the corpus
itself in one night — and on the same frozen benchmark it wins the head-to-head.

## 🏆 Headline results

On **2,000 held-out queries** retrieved against the **full 433,449-preprint corpus**,
this model beats `ncbi/MedCPT` — the National Library of Medicine's biomedical
retriever — **0.6150 vs 0.5900 blended R@10**, a paired-McNemar win at **p = 0.016**.
On MeSH concept queries the margin is large; on author-keyword queries MedCPT is still
ahead, and both are shown below.

**MeSH concept queries** — expert subject headings, the professional-search case (n = 1,241)

| Method | R@1 | R@10 | nDCG@10 |
|---|---:|---:|---:|
| **Hybrid — RRF(FTS + this model)** *(the production arm)* | **0.272** | **0.533** | **0.394** |
| **`cshl-encoder-bge-m3-qpairs2`** *(this model)* | **0.269** | **0.524** | **0.388** |
| `cshl-encoder-bge-m3-qpairs` *(sibling, 40k pairs)* | 0.222 | 0.432 | 0.319 |
| `allenai/specter2_base` | 0.153 | 0.351 | 0.247 |
| `cshl-encoder-bge-m3` *(sibling, citation-trained)* | 0.157 | 0.332 | 0.237 |
| Dense — stock `BAAI/bge-m3` *(the base model)* | 0.118 | 0.286 | 0.194 |
| Postgres FTS (keyword search) | 0.047 | 0.081 | 0.063 |

*Against `ncbi/MedCPT` — the National Library of Medicine's biomedical retriever, trained
on roughly 255 million real PubMed search-click pairs — this model **wins MeSH concept
retrieval by +14.7 % relative** (0.524 vs 0.457 R@10; nDCG@10 0.388 vs 0.337).*

**Author-keyword queries** (n = 759)

| Method | R@1 | R@10 | nDCG@10 |
|---|---:|---:|---:|
| **Hybrid — RRF(FTS + this model)** *(the production arm)* | **0.549** | **0.780** | **0.668** |
| **`cshl-encoder-bge-m3-qpairs2`** *(this model)* | **0.535** | **0.764** | **0.650** |
| `cshl-encoder-bge-m3-qpairs` *(sibling, 40k pairs)* | 0.534 | 0.750 | 0.640 |
| `allenai/specter2_base` | 0.497 | 0.726 | 0.610 |
| `cshl-encoder-bge-m3` *(sibling, citation-trained)* | 0.461 | 0.669 | 0.563 |
| Dense — stock `BAAI/bge-m3` *(the base model)* | 0.457 | 0.652 | 0.552 |
| Postgres FTS (keyword search) | 0.217 | 0.240 | 0.229 |

*On author-keyword queries `ncbi/MedCPT` still leads (0.808 vs 0.764 R@10) — short keyword
strings are exactly what 255M click pairs teach best. **Blended across both families this
model takes the head-to-head, 0.615 vs 0.590 R@10, a paired-McNemar win at p = 0.016.***

Every arm is scored on the same queries, against the same 433,449-document universe,
with the same metric code, and each model is scored with the similarity function its
authors published it for (cosine for bge-m3 derivatives; inner product over raw `[CLS]`
for MedCPT and SPECTER2). Paired exact McNemar and 5,000-sample bootstrap CIs
throughout.

## Where this model loses

Mandatory section, and the useful one.

- **Author-keyword queries: −0.043 R@10 against MedCPT** (0.764 vs 0.808, p = 0.005).
  Short keyword strings are exactly what 255M PubMed click pairs teach best. Our
  advantage is concept queries; theirs is keywords.
- **Document→document similarity: this model gave the crown back.** Its sibling
  `cshl-encoder-bge-m3` — trained on citation pairs — scores **0.2120** R@10 on a
  10,000-pair doc→doc benchmark; this model scores **0.1960**, statistically
  indistinguishable from stock bge-m3 (0.1955). Query-shaped supervision bought
  query→document retrieval and spent the document-similarity advantage. **They are two
  specialists: use this one for a search box, the citation sibling for "related
  papers", reviewer matching and systematic-review expansion.**
- **One run, two variables.** Against the 40k sibling this run changed both pair count
  (40k → 100k) and family mix (benchmark-weighted). The gain is not attributed between
  them.
- **A third run failed.** A 140k successor adding OpenAlex-concept queries and ANCE
  hard negatives scored **0.3997** MeSH — worse than this model *and* worse than the
  40k sibling. More data made it worse; that negative result is recorded rather than
  buried, and it is why this checkpoint, not a later one, is published.

## Training

| | |
|---|---|
| base | `BAAI/bge-m3` |
| objective | in-batch contrastive, dense only (`--unified_finetuning False`) |
| trainer | FlagEmbedding `finetune.embedder.encoder_only.m3` |
| pairs | **100,000** — MESH 55,000 · AUTHORKW 40,000 · EXTRACT 5,000 (emitted counts, verified against the manifest) |
| negatives / pair | 8 · group size 8 |
| query / passage max len | 128 / 384 tokens |
| batch / epochs / steps | 8 / 1 / 12,500 — no OOM halving; batch 8 held throughout |
| precision | bf16 |
| hardware / wall-clock | 1× NVIDIA L40S (`g6e.2xlarge`), 2 h 22 m of training, ≈ $5.68 billed |
| final train loss | 0.2100 |

Pairs are mined from the corpus's own structure: MeSH descriptors and author keywords
as queries, the paper they annotate as the positive. **Leakage is computed, not
asserted** — 0 of the emitted pairs reference any of the 6,203 gold papers in the
frozen benchmark, checked against `qrels.tsv` after emission rather than before.

## Evaluation methodology

`cshl-eval-v1`, frozen 2026-08-19 before any training, split **by paper** so a paper's
queries cannot straddle the boundary. Scored on the frozen 2,000-query subsample
(`sha256 32433e4d…`), retrieved against all 433,449 papers — not against each row's own
negatives, which would measure reranking and flatter every arm. `hnsw.ef_search = 100`;
every arm confirmed to use an Index Scan, so no arm silently fell back to a sequential
scan. Coverage of the vector table re-derived at assertion time: 433,449 / 433,449,
zero nulls, zero dimension faults.

## Usage

```python
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("NYSgpt/cshl-encoder-bge-m3-qpairs2")
v = m.encode(["gut microbiome depression"], normalize_embeddings=True)
```

Serve with Hugging Face TEI. `sentence_bert_config.json` carries `max_seq_length 384`,
matching what it was trained at — do not raise it at serve time without re-embedding
the corpus.

**Pair it with a reranker.** `NYSgpt/cshl-reranker-gte-modernbert` re-scores this
model's top-50 and lifts MeSH R@10 from 0.524 to **0.549** — above MedCPT's full
retriever-plus-cross-encoder system (0.525).

## Corpus and licensing

433,449 preprints (bioRxiv 345,882 + medRxiv 87,567) harvested from the public
bioRxiv/medRxiv APIs. The corpus is licence-mixed and mostly restrictive —
`cc_by_nc_nd` 35.5 %, `cc_no` (all rights reserved) 29.9 %, `cc_by` 20.2 %,
`cc_by_nc` 6.8 %, `cc_by_nd` 6.4 %, `cc0` 1.1 % — which is why this repository and its
siblings are private. No corpus text is redistributed here; these are weights.

## Provenance

Run `20260819-232838-train`, part of **CSHL-CPT** with `cshl-encoder-bge-m3`,
`cshl-encoder-bge-m3-qpairs`, `cshl-reranker-gte-modernbert` and the `cshl-eval-v1`
benchmark. Built by NYSgpt, 2026-08-20.
