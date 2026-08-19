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
## Licensing — measured, not assumed

Preprint metadata and abstracts are redistributed by the servers under **per-paper**
licences. This corpus is not uniformly permissive:

{{LICENSE_TABLE}}

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
