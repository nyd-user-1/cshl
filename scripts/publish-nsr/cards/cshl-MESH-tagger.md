---
license: apache-2.0
base_model: answerdotai/ModernBERT-base
library_name: transformers
pipeline_tag: text-classification
tags: [text-classification, multi-label, mesh, biomedical, preprints, biorxiv, medrxiv, CSHL-CPT]
language: [en]
---

# cshl-MESH-tagger

> ## ⚠️ Read this first: we measured this model and decided **not** to serve it.
>
> It is beaten on every threshold-free ranking metric by a k-nearest-neighbour vote over
> embeddings we already store — a baseline that needs **no model, no weights, and no
> inference box**. It is published for the record and for reproducibility, not as a
> recommendation. If you want MeSH descriptors for a preprint corpus, do the kNN lookup
> instead. The negative result is the useful part of this artifact.

A ModernBERT-base multi-label classifier that reads a preprint's title and abstract and
predicts **MeSH descriptors** (4,920-way, BCE head). Trained as the multi-label half of the
CSHL-CPT "librarian" — the component that fills in topical labels so a corpus can be
partitioned into scoped rooms.

## The verdict, on the full held-out test split (n = 13,127)

| arm | P@5 | P@10 | R@10 | R@15 |
|---|---:|---:|---:|---:|
| cshl-MESH-tagger @ 0.20 | 58.68 | 41.00 | 46.40 | 52.66 |
| **kNN over stock `BAAI/bge-m3`** | **63.39** | **46.36** | **53.72** | **61.82** |

Beaten by **4.7–9.2 points on every ranking metric**, and reproduced on an independent
frozen 10,000-row evaluation set.

The model does win on micro-F1 (44.50 vs 39.67 on matched rows), but that comparison is
confounded and we do not lean on it: the two arms sit at different label budgets (6.80 vs
3.35 labels per document) and only the model's decision threshold was tuned. The
threshold-free ranking metrics are the fair comparison, and they go the other way.

## Why it lost — the part worth reusing

**Macro-F1 over occurring labels is 1.86%.** The head collapsed onto frequent descriptors
and never learned the tail. Meanwhile MeSH assignment is strongly predicted by document
similarity, which is precisely what a retrieval-trained encoder already encodes — so the
free baseline was always going to be strong on this task.

The generalisable lesson, which we now apply to every new domain: **single-label over a
small space, train the classifier; multi-label over a huge space, test the free baseline
first and expect to skip the training run.** The sibling model `cshl-category` (76 classes,
single-label) beat the same kind of baseline by ~7 points; this one lost.

## Calibration matters more than the architecture here

At the default threshold of 0.5 the model emitted **2.81 labels per paper against 9.10
observed** and micro-F1 read 36.81%. Sweeping the threshold on validation only (never test)
moved it to 45.62% at **0.20** — a **+8.8 point** swing that cost nothing. Any use of this
model should tune the threshold on its own data; the checkpoint's default is wrong.

| threshold | micro F1 | precision | recall | labels/doc |
|---|---:|---:|---:|---:|
| 0.50 (default) | 36.81 | 78.38 | 24.06 | 2.79 |
| 0.30 | 43.84 | 64.94 | 33.09 | 4.63 |
| **0.20 (chosen)** | **45.62** | 54.61 | 39.17 | 6.51 |
| 0.15 | 45.28 | 47.53 | 43.23 | 8.26 |
| 0.10 | 42.90 | 38.44 | 48.52 | 11.46 |

## Training

| | |
|---|---|
| base | `answerdotai/ModernBERT-base` |
| task | multi-label, 4,920 descriptors, BCE |
| label space | cut at min document-frequency 20 — keeps 92.7% of label mass, drops 15,254 rare descriptors from an observed 20,174 |
| data | 102,725 train / 12,882 val / 13,127 test |
| schedule | 3 epochs, batch 32, max_len 1024, 9,630 steps (~30 min) |
| leakage | zero, re-derived from the split rule rather than read off a manifest |

## A limit inherited from the labels themselves

MeSH descriptors come from NLM indexing, which happens at journal publication. In this
corpus **100% of MeSH-labelled papers are published**, while 71.6% of unlabelled papers are
not. Both this model and its kNN baseline were therefore trained and evaluated exclusively
on published papers, and neither has been validated on the unpublished majority they would
be applied to. (Checked separately: the unlabelled population is not geometrically distant
from the labelled one — median nearest-labelled-neighbour cosine distance 0.2594 vs 0.2541
— so propagation is not extrapolating into empty space. But the evaluation cannot see this
shift, and you should know that before trusting either arm on unpublished text.)

Part of the CSHL-CPT model family, published for completeness. Its sibling `cshl-category`
is the arm that cleared its bar.
