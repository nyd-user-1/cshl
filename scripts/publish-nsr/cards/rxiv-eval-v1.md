---
license: other
task_categories: [text-retrieval]
tags: [benchmark, retrieval, biomedical, preprints, biorxiv, medrxiv]
---

# rxiv-eval-v1

A **frozen retrieval benchmark** over the bioRxiv + medRxiv corpus. Queries, gold
labels, and the exact arm configurations used to produce the published numbers.

The aim is not to win it. The aim is to be the number others compare against — so
every baseline is measured here on the same corpus, the same queries and the same
metric code, rather than quoted from its own paper.

## Contents

| file | rows | what |
|---|---:|---|
| `queries.jsonl` | {{N_QUERIES}} | `{qid, family, text, server, pub_year, published, abs_len}` |
| `qrels.tsv` | {{N_QRELS}} | `qid \t key_number`, one line per gold pair |
| `manifest.json` | 1 | freeze date, holdout rule, per-family provenance, leak audit |
| `results/*.json` | {{N_ARMS}} | one file per scored arm, per-family and per-segment |

## Query families

| family | queries | source | note |
|---|---:|---|---|
| `MESH` | {{N_MESH}} | NLM MeSH descriptors on the published half | hierarchical, indexer-assigned gold |
| `CITE` | {{N_CITE}} | held-out citation pairs | document-shaped, not query-shaped |
| `SYNTH` | {{N_SYNTH}} | LLM questions over held-out abstracts | the only genuinely query-shaped family |
| `TITLE` | {{N_TITLE}} | the paper's own title | **leaked by construction** — a plumbing floor, never blended into a headline |

`TITLE` is reported separately and explicitly. An arm that cannot find a paper from
its own title is broken; that is all this family proves.

## Split

25% of **papers** held out by `md5("holdout:" || key_number) < 0.25`, frozen before
any training. Split by paper, never by query, so a paper's queries cannot straddle
the boundary. Leak audit at freeze time: **{{N_LEAKS}}** of {{N_AUDITED}} non-TITLE
queries appear verbatim inside their own document.

## Metrics

R@1, R@5, R@10, R@50, MRR, nDCG@10 — per family and per segment
(`server`, `era`, `published`, `abstract` length band).

## Arms measured

Postgres FTS · stock `BAAI/bge-m3` · `ncbi/MedCPT` (query + article encoders) ·
`allenai/specter2_base` · `malteos/scincl` · `NYSgpt/rxiv-encoder-bge-m3` ·
RRF fusions · cross-encoder rerank stages.

{{RESULTS_TABLE}}

## Reproducing

```bash
node scripts/eval/build-rxiv-eval.mjs                 # freeze (deterministic)
ARM=bge-m3 node scripts/eval/embed-queries.mjs        # query side, per arm
ARMS=fts,bge-m3,medcpt,rrf:fts+bge-m3 node scripts/eval/score.mjs
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
