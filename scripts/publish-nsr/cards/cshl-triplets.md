---
license: other
task_categories: [text-retrieval]
tags: [retrieval, contrastive, biomedical, preprints, biorxiv, medrxiv]
---

# cshl-triplets

Contrastive training data for preprint retrieval: `{query, positive, negatives[]}`
over the **bioRxiv + medRxiv** corpus. This is the set `NYSgpt/cshl-encoder-bge-m3`
and `NYSgpt/cshl-reranker-gte-modernbert` were trained on.

## Contents

| file | records | shape |
|---|---:|---|
| `train.jsonl` | 40,000 (of 132,793 available) | `{"query": str, "pos": [str], "neg": [str]}` (FlagEmbedding) |
| `train-groups.jsonl` | n/a — reranker not trained | `{"q": str, "pos": str, "negs": [str], "src": str}` (cross-encoder) |
| `manifest.json` | 1 | provenance, holdout audit, input hashes |

## Where the supervision comes from

| signal | records | how |
|---|---:|---|
| citation graph | 0 | cited work = positive; citation-of-a-citation that is not itself cited = hard negative (the SPECTER/SciNCL recipe) |
| MeSH terms via the published DOI | 1,241 | NLM-indexer-assigned descriptors as queries against the ~49% of the corpus that reached a journal |
| synthetic queries | 0 | LLM-generated questions over abstracts — the only source that is actually query-shaped rather than document-shaped |
| category labels | 0 | same-category papers as harder-than-random negatives |

Version pairs and preprint↔published pairs were deliberately **excluded** from the
triplet set: they are near-duplicates, and a model trained on them learns lexical
overlap. They are retained elsewhere for robustness evaluation only.

## Holdout guarantee

`manifest.json` asserts `disjointness.pass = true`. That claim is audited against
what the converter **emitted**, not what it read: zero held-out papers appear as an
anchor, a positive, or a negative. The trainer refuses to start on a slice whose
manifest does not carry that assertion.

This is not a hypothetical guard. The predecessor project's first mining sweep
leaked held-out papers into 24.7% of negative slots and cost a full retrain.

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
- **Licensing:** preprint metadata and abstracts are redistributed by the servers
  under per-paper licenses (`cc_by_nc_nd` 35.1%, `cc_no` 28.3%, `cc_by` 21.6%, `cc_by_nc` 8.1%, `cc_by_nd` 5.5%, `cc0` 1.0%, `cc0_ng` 0.3%, `unstated` 0.1%). **Nothing in this repo redistributes
  full text.** Confirm CSHL's terms before flipping any repo public.

## Split discipline

25% of *papers* are held out by `md5("holdout:" || key_number)`, frozen before any
training, and the same hash rule is used by the benchmark builder, the encoder
triplet converter and the reranker group converter — so a held-out paper cannot
appear as a positive, a negative, or an anchor anywhere in training. The converters
audit what they **emit** (not what they read) and refuse to write a set that leaks.
