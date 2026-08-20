---
license: other
task_categories: [text-retrieval]
tags: [benchmark, retrieval, biomedical, preprints, biorxiv, medrxiv]
---

# cshl-eval-v1

A **frozen retrieval benchmark** over the bioRxiv + medRxiv corpus. Queries, gold
labels, and the exact arm configurations used to produce the published numbers.

The aim is not to win it. The aim is to be the number others compare against — so
every baseline is measured here on the same corpus, the same queries and the same
metric code, rather than quoted from its own paper.

## Contents

| file | rows | what |
|---|---:|---|
| `queries.jsonl` | 2,000 (frozen deterministic subsample of 10,000) | `{qid, family, text, server, pub_year, published, abs_len}` |
| `qrels.tsv` | 2,000 | `qid \t key_number`, one line per gold pair |
| `manifest.json` | 1 | freeze date, holdout rule, per-family provenance, leak audit |
| `results/*.json` | 18 | query→document: one file per scored arm, per-family and per-segment |
| `results/*.perquery.json` | — | per-query hit/miss, so a paired significance test can be run against any arm without rescoring |
| `results-docdoc/*.json` | 10 | document→document: the "more like this" task, scored separately |

## Query families

| family | queries | source | note |
|---|---:|---|---|
| `MESH` | 1,241 | NLM MeSH descriptors on the published half | hierarchical, indexer-assigned gold |
| `AUTHORKW` | 759 | author-supplied keywords on the published half | the authors' own vocabulary, not an indexer's |
| `CITE` | 0 | held-out citation pairs | document-shaped, not query-shaped |
| `SYNTH` | 0 | LLM questions over held-out abstracts | the only genuinely query-shaped family |
| `TITLE` | 0 | the paper's own title | **leaked by construction** — a plumbing floor, never blended into a headline |

`TITLE` is reported separately and explicitly. An arm that cannot find a paper from
its own title is broken; that is all this family proves.

## Split

25% of **papers** held out by `md5("holdout:" || key_number) < 0.25`, frozen before
any training. Split by paper, never by query, so a paper's queries cannot straddle
the boundary. Leak audit at freeze time: **0** of 2,000 non-TITLE
queries appear verbatim inside their own document.

## Metrics

R@1, R@5, R@10, R@50, MRR, nDCG@10 — per family and per segment
(`server`, `era`, `published`, `abstract` length band).

## Arms measured

Postgres FTS · stock `BAAI/bge-m3` · `ncbi/MedCPT` (query + article encoders) ·
`allenai/specter2_base` · `malteos/scincl` · `NYSgpt/cshl-encoder-bge-m3` (CITE,
document→document supervision) · **`NYSgpt/cshl-encoder-bge-m3-qpairs`** (query→document
supervision) · RRF fusions · cross-encoder rerank stages.

`CSHL-CPT-REPORT.md` ships in this repo and carries the full table, the method, and every
failure worth knowing about.

## Headline, 2026-08-20 — the query-shaped retrain

The benchmark existed to settle one question: whether our encoder trailed `ncbi/MedCPT`
because of an **objective mismatch** — trained document→document, evaluated query→document.
Scored here, on these queries, it did.

| arm | MeSH R@10 | AUTHORKW R@10 |
|---|---:|---:|
| RRF(qpairs + MedCPT + FTS) | **0.5197** | **0.8300** |
| `ncbi/MedCPT` | 0.4569 | 0.8076 |
| `cshl-encoder-bge-m3-qpairs` | **0.4319** | 0.7497 |
| `cshl-encoder-bge-m3` (CITE) | 0.3320 | 0.6693 |
| Postgres FTS | 0.0806 | 0.2398 |

MeSH R@10 **0.3320 → 0.4319, +30.1%**, closing 80% of the gap to MedCPT (paired McNemar
p = 2.3e-16). Against MedCPT itself the MeSH difference is **no longer significant**
(p = 0.071, CI [−0.0516, +0.0016]) — while on `AUTHORKW` **MedCPT is still significantly
better** (p = 0.0003) and that is not rounded off.

It was a trade, not a free win: on document→document the qpairs model drops to 0.1980 R@10
against CITE's 0.2120 (p = 0.043), which is statistically indistinguishable from the base
model it started from (stock bge-m3, 0.1955, p = 0.78). See `results-docdoc/`. Both encoders
stay published because they are good at different tasks.

One confound, stated rather than buried: that run changed the objective **and** doubled the
effective batch (4 → 8), and cannot separate them. See the report.

## Reproducing

```bash
node scripts/eval/build-rxiv-eval.mjs                 # freeze (deterministic)
ARM=bge-m3 node scripts/eval/embed-queries.mjs        # query side, per arm
ARMS=fts,bge-m3,medcpt,rrf:fts+bge-m3 node scripts/eval/score.mjs
```

<!-- Shared corpus/provenance block — kept verbatim across every card in this
     program, so it is updated in one place when the corpus changes. -->

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
