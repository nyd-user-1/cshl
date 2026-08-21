---
license: apache-2.0
base_model: Alibaba-NLP/gte-reranker-modernbert-base
library_name: transformers
pipeline_tag: text-ranking
tags: [reranker, cross-encoder, biomedical, preprints, biorxiv, medrxiv, CSHL-CPT]
language: [en]
---

# cshl-reranker-gte-modernbert

The **CSHL-CPT reranker**: a 149M cross-encoder fine-tuned from
[`Alibaba-NLP/gte-reranker-modernbert-base`](https://huggingface.co/Alibaba-NLP/gte-reranker-modernbert-base)
to re-score retrieval candidates over bioRxiv + medRxiv preprints. Takes
`(query, document)`, returns a relevance logit. Second stage over any dense or hybrid
top-K in RxivGPT.

## 🏆 Headline results — it beats the NLM's own cross-encoder on concept queries

Handed **MedCPT's own candidate pool**, this reranker is a statistical dead heat with
`ncbi/MedCPT-Cross-Encoder` overall (Δ blended R@10 −0.0010, **p = 0.93**) and beats it
outright on MeSH concept queries (**+0.0193, p = 0.013**). The single best MeSH
configuration measured anywhere in this program is MedCPT's retriever with **this**
reranker on top.

**MeSH concept queries** (n = 1,241)

| System | R@1 | R@10 | nDCG@10 |
|---|---:|---:|---:|
| **`cshl-encoder-bge-m3-qpairs2` + this reranker** *(our full system)* | **0.306** | **0.549** | **0.419** |
| **`cshl-encoder-bge-m3-qpairs` + this reranker** | **0.302** | **0.524** | **0.408** |
| `cshl-encoder-bge-m3-qpairs2` *(retrieval only)* | 0.269 | 0.524 | 0.388 |
| `cshl-encoder-bge-m3-qpairs` *(retrieval only)* | 0.222 | 0.432 | 0.319 |
| `allenai/specter2_base` *(retrieval only)* | 0.153 | 0.351 | 0.247 |
| Dense — stock `BAAI/bge-m3` *(retrieval only)* | 0.118 | 0.286 | 0.194 |
| Postgres FTS (keyword search) | 0.047 | 0.081 | 0.063 |

*Two comparisons against the National Library of Medicine's stack, both favourable:
handed **MedCPT's own candidate pool**, this reranker **beats `ncbi/MedCPT-Cross-Encoder`
outright on MeSH** (0.544 vs 0.525 R@10, +0.019, p = 0.013) — and our complete system
above (0.549) also **edges their complete system** (0.525) on the concept queries
professionals actually search with.*

**Author-keyword queries** (n = 759)

| System | R@1 | R@10 | nDCG@10 |
|---|---:|---:|---:|
| **`cshl-encoder-bge-m3-qpairs2` + this reranker** *(our full system)* | **0.596** | **0.802** | **0.700** |
| **`cshl-encoder-bge-m3-qpairs` + this reranker** | **0.577** | **0.767** | **0.675** |
| `cshl-encoder-bge-m3-qpairs2` *(retrieval only)* | 0.535 | 0.764 | 0.650 |
| `cshl-encoder-bge-m3-qpairs` *(retrieval only)* | 0.534 | 0.750 | 0.640 |
| `allenai/specter2_base` *(retrieval only)* | 0.497 | 0.726 | 0.610 |
| Dense — stock `BAAI/bge-m3` *(retrieval only)* | 0.457 | 0.652 | 0.552 |
| Postgres FTS (keyword search) | 0.217 | 0.240 | 0.229 |

*On author-keyword queries MedCPT's full system remains ahead (0.858 vs 0.802 R@10) —
its 255M PubMed click pairs are keyword-shaped supervision we cannot match in volume.
**Blended across both families the two complete systems are a statistical dead heat**
(0.645 vs 0.651, p = 0.55), and on the same pool this reranker ties their purpose-built
cross-encoder (−0.001, p = 0.93) after 45 minutes of training.*

**What the reranker adds, isolated:** over its own encoder's top-50 it lifts MeSH R@10
from 0.432 to 0.524 (**+21 %**) and R@1 from 0.222 to 0.302 (**+36 %**); 19 of 20
measured segments improve on both R@10 and nDCG@10.

## Two caveats that cut in opposite directions

- **This model is domain-tuned; `MedCPT-Cross-Encoder` is zero-shot on preprints.**
  That a fine-tuned reranker only *ties* a zero-shot one overall is less flattering
  than the tie sounds, and it is stated here rather than left for a reader to notice.
- **MedCPT trained on PubMed, and much of this corpus consists of preprints of
  PubMed-indexed papers.** Part of its author-keyword advantage may be familiarity with
  these very documents, which makes that gap an upper bound on its real modelling edge.

## A reranker cannot retrieve what its pool does not contain

Ceilings, measured as R@50 of the retriever that built each pool:

| pool | MeSH | author-keyword |
|---|---:|---:|
| `cshl-encoder-bge-m3-qpairs` | 0.608 | 0.821 |
| `ncbi/MedCPT` | 0.624 | 0.892 |
| `cshl-encoder-bge-m3-qpairs2` | **0.673** | 0.867 |

Every number in the tables above is bounded by one of these. Note the asymmetry that
explains the two result tables: our retriever offers the richer MeSH pool (0.673 vs
0.624) and MedCPT the richer author-keyword pool (0.892 vs 0.867) — which is exactly
where each system wins. Feed this model a better retriever and its ceiling moves with
it.

## Training

| | |
|---|---|
| base | `Alibaba-NLP/gte-reranker-modernbert-base` (149M, 8192 ctx) |
| groups | **40,000** — 1 positive + hard negatives per group |
| negatives | mined from the retrieval space itself, not sampled at random — a reranker trained on random negatives learns topicality, not ranking |
| epochs / max len | 2 / 256 |
| hardware / wall-clock | 1× NVIDIA L40S (`g6e.2xlarge`), 45.1 min, ≈ $1.69 |

**Known defect, disclosed:** the group converter emitted **5.90 negatives per group on
average** where the trainer expects 7, and padded the shortfall by repetition. Training
with a converter that backfills instead is an untested and probably free improvement.

Holdout discipline: benchmark gold papers are excluded as queries and positives, and
the exclusion is computed on what was *emitted*, not on what was read.

## Serving cost, measured

**326 pairs/s on one A10G**; **p50 151 ms · p95 163 ms** per query over 50 candidates
at batch 256, 256-token truncation. That is fast enough to sit behind a live search box
on a single cheap GPU. **CPU latency is unmeasured** — a serving-tier decision cannot
be made from this number alone.

## Usage

```python
from sentence_transformers import CrossEncoder
ce = CrossEncoder("NYSgpt/cshl-reranker-gte-modernbert", max_length=256)
ce.predict([("gut microbiome depression",
             "Interplay of Human Metabolome and Gut Microbiome in Major Depression ...")])
```

Retrieve a top-50 with `NYSgpt/cshl-encoder-bge-m3-qpairs2`, re-score with this model,
serve the reordered list.

## Corpus and licensing

Trained over 433,449 bioRxiv + medRxiv preprints. The corpus is licence-mixed and
mostly restrictive (`cc_by_nc_nd` 35.5 %, `cc_no` all-rights-reserved 29.9 %, `cc_by`
20.2 %, remainder smaller), which is why this repository is private. No corpus text is
redistributed here.

## Provenance

Run `20260819-223601-train`, part of **CSHL-CPT** with `cshl-encoder-bge-m3`,
`cshl-encoder-bge-m3-qpairs`, `cshl-encoder-bge-m3-qpairs2` and the `cshl-eval-v1`
benchmark. Built by NYSgpt, 2026-08-20.
