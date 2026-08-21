---
license: apache-2.0
base_model: answerdotai/ModernBERT-base
library_name: transformers
pipeline_tag: text-classification
tags: [text-classification, biomedical, preprints, biorxiv, medrxiv, CSHL-CPT, librarian]
language: [en]
---

# cshl-category

The **CSHL-CPT librarian (category arm)**: a ModernBERT-base classifier that reads a
preprint's title and abstract and returns its bioRxiv/medRxiv subject category — one of
**76**, single-label. Its job in RxivGPT is not query routing. It is a *librarian*: it
files papers into scoped "rooms" that a subject agent later searches, and completes the
label where the source did not supply one.

## Headline — it beats the free baseline, which is the only comparison that matters

A classifier is only worth serving if it beats what you can already do for nothing. We
have embeddings for the whole corpus, so the honest baseline is a k-nearest-neighbour vote
over them. It was scored on identical rows.

| arm | accuracy | macro F1 |
|---|---:|---:|
| majority-class floor | 14.45% | 0.33% |
| kNN over stock `BAAI/bge-m3` (k=15) | 58.12% | 35.46% |
| **cshl-category** | **65.09%** | **50.44%** |

**+6.97 pp accuracy and +15 pp macro F1 over kNN.** The macro-F1 gap is the more
interesting one: it means the model is materially better than similarity voting on the
*small* categories, which is exactly where a labeller is needed.

Scored on a held-out test split (n = 32,794) and, independently, on a frozen 10,000-row
evaluation set. **The two agree to 0.08 pp** (65.09% vs 65.17%), which says the test split
is not lucky.

## The 35% that is "wrong" is mostly not wrong

The target is the category the author self-assigned at submission — a single label on
papers that frequently belong to two fields at once. The top confusions are all genuinely
overlapping pairs, several of them symmetric:

| confusion (gold → predicted) | n |
|---|---:|
| genomics → bioinformatics | 170 |
| infectious diseases → epidemiology | 156 |
| biochemistry → biophysics | 136 |
| public and global health → epidemiology | 120 |
| biophysics → biochemistry | 118 |
| molecular biology → cell biology | 115 |

Treat this as a ceiling imposed by the label, not by the model. Downstream, prefer showing
a user two or three candidate categories over asserting one.

## Training

| | |
|---|---|
| base | `answerdotai/ModernBERT-base` |
| task | single-label, 76 classes |
| data | 259,890 train / 32,277 val / 32,794 test |
| schedule | 1 epoch, batch 32, max_len 1024, lr 3e-5, 8,122 steps (~19 min) |
| leakage | zero, re-derived from the split rule rather than read off a manifest |

Supervision is the corpus's own structure — the category authors assign at submission. No
labels were purchased or hand-annotated.

## Intended use and limits

Built for **filing**, not for query-time routing. In RxivGPT the user's navigation choice
selects the room; this model decides which room a *paper* belongs in, and fills gaps where
the source label is absent. Confidence is not calibrated for downstream thresholding
out of the box.

It is trained on bioRxiv/medRxiv preprints in English. Its label space is those servers'
categories and does not transfer to other corpora.

Part of the CSHL-CPT model family. See also `cshl-encoder-bge-m3-qpairs2` (retrieval),
`cshl-reranker-gte-modernbert` (re-ranking).
