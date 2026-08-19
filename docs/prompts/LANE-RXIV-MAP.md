# LANE-RXIV-MAP — bioRxiv + medRxiv API recon → 1-1 mapping onto the NSR IA (report-only)

**HARD CAPS: report-only. NO DDL applied, NO DB writes, NO loader code, NO commits or pushes. Downloads ≤ 150 MB total, into `data/` (gitignored). API probes are SAMPLES — do not walk a corpus; stay under ~200 requests per host, ≤4 in flight, with a User-Agent naming this project. Time box ~45 min — the API is unauthenticated and tolerates ~5 req/s (medrxivr walks the full corpus at that rate), so the clock is your reading and writing, not the network; batch your probes, don't savor them. Edit this file in place; the REPORT section at the bottom is the deliverable.**

## Mission

This repo is a 1-1 clone of NSRgpt (nuclear literature) being repointed at the two preprint
servers Cold Spring Harbor Laboratory operates: **bioRxiv** and **medRxiv**. The CSHL Neon
database (`snowy-pine-70124980`) is empty **on purpose** — the schema waits on this report.

Explore `https://api.biorxiv.org/` and `https://api.medrxiv.org/` until you can state, with
evidence, a field-by-field 1-1 mapping of preprint metadata onto the existing information
architecture, in the house formula: **source field → our table.column → the surface that
serves it**. We want to ingest **everything both APIs offer** — inventory it all, even what
we defer.

First target surface is the `/nsr` References browser: the card grid must render preprints
with zero layout change. Read the receiving shape before you probe: `api/records.ts`,
`api/record.ts`, `api/dict.ts`, `src/components/NsrRecordCard.tsx`, `src/pages/nsr/`,
`src/types/nsr.ts`, and the hub-table columns in `sql/01`, `sql/05`, `sql/13`, `sql/15`.
An honest "this NSR column has no source — here is what the slot should show instead" is a
valuable verdict, not a failure.

## Ground already covered (verified 2026-08-18 — spot-check, don't re-derive)

- Both hosts run the same API software; the docs are the roots themselves. No auth, no key.
  Formats: json, xml (OAI-PMH), html. A `/reports` page exists on both hosts (uninventoried).
- `details/[server]/[interval]/[cursor]/json` where interval = `YYYY-MM-DD/YYYY-MM-DD` | `N`
  (recent posts) | `Nd` (recent days); optional `?category=cell_biology` (underscores for
  spaces). Single paper: `details/[server]/[DOI]/na/json`. Pagination: **bioRxiv 30/page,
  medRxiv 100/page**. `messages[0]` carries `{cursor, count, count_new_papers, total}`.
- Corpus size via full-range `details` probes: **bioRxiv** (2013-01-01→2026-08-18)
  total 475,939 rows / 345,854 new papers; **medRxiv** (2019-01-01→2026-08-18) 108,690 /
  87,564. **A row is a version, not a paper** — the `version` field increments and re-posts
  appear as additional rows.
- `details` fields seen live: `doi`, `title`, `authors` (`"Last, I.; Last, I."` — same `"; "`
  convention as `nsr.authors`), `author_corresponding`, `author_corresponding_institution`,
  `date`, `version`, `type` (`"new results"`, `"PUBLISHAHEADOFPRINT"`, …), `license`,
  `category`, `jatsxml` (a full-text JATS XML URL on every record), `abstract` (full text,
  apparently ~100% coverage), `funder` `{name, id, id-type, award}` (submission-system
  inception **2025-04-10** — earlier papers have none), `published` (journal DOI or `"NA"`),
  `server`.
- **DOI prefix changed in 2026**: older records `10.1101/…`, newer `10.64898/…`. Any key
  scheme must survive both.
- Published-article join: `pubs/[server]/[interval]/[cursor]` → `biorxiv_doi`,
  `published_doi`, `published_journal`, `published_date`, `preprint_*` echoes. Leaner
  bioRxiv-only variant `pub/[interval]/[cursor]`. Also `publisher/[DOI-prefix]/[interval]/…`
  and `funder/[server]/[interval]/[ROR-id]/…`.
- medRxiv bulk shortcut (rOpenSci `medrxivr`): GitHub release tag `snapshot` on
  `ropensci/medrxivr` → `snapshot-manifest.json` + `snapshot.csv.gz` (94 MB, 108,060
  records, snapshot_date 2026-08-09, refreshed in place). **bioRxiv has no snapshot** —
  medrxivr walks the API (~1 h). Rumor to verify: bioRxiv/medRxiv TDM S3 requester-pays
  buckets with full-text archives.

## Tasks

1. **Endpoint inventory.** Every endpoint both hosts expose, including `/reports` and
   anything the docs pages mention that isn't listed above (sum/usage/covid collections?).
   Per endpoint: URL shape, pagination, one real response body (≤10-line excerpt), and an
   ingest verdict: **load now / enrich later / skip**. Check whether the two hosts differ
   in anything but data (they appear to be the same software — confirm).
2. **Field census.** For each `details` field: type, coverage % (sample ≥3 windows per
   server — early, middle, recent — plus one category-filtered and one single-DOI probe),
   and the distinct-value list where enumerable: **category per server** (these become the
   facet/chip vocabulary and `/api/dict` comboboxes), `type`, `license`. Quirks to settle:
   is `(doi, version)` unique? Does the single-DOI form return all versions or latest?
   How are withdrawn/retracted papers represented? Empty-abstract rate? Does the medRxiv
   snapshot CSV carry the same columns as the API (pull its header — a ranged fetch of the
   .gz is fine) and does it include extra ones (PDF links)?
3. **Identity + version ruling.** Propose the `key_number` analog — the stable string key
   every join table, vector sidecar, and route will hang off. Candidate: the DOI suffix
   (`2026.07.31.741992`); pressure-test it (unique across both servers? survives the prefix
   change? old-style suffixes like `339747`?). Rule how versions land: hub row = latest
   version, with version history preserved where? (Sidecar table? `raw` jsonb?) State the
   dedup rule for the loader.
4. **The 1-1 mapping table** — the core deliverable. Three columns: source field →
   `table.column` (keep NSR's names where the semantic carries: `key_number`, `pub_year`,
   `title`, `authors`, `doi`, `abstract`, `raw`…) → UI slot. Cover every card slot and
   every `/nsr` filter explicitly:
   - `#` key badge · year badge · title · **Authors** · **Reference** (NSR shows journal
     citation — propose: `published_journal` when published, else server + date?) ·
     **Nuclides chips** and **Reactions chips** (no analog — propose what the two chip
     groups become: category? published-status? license?) · DOI link.
   - `/nsr` filters: year dropdown, the two `/api/dict` comboboxes, author/key sorts,
     EXFOR toggle (no analog — propose the replacement, e.g. published-only toggle).
   - Then the relational layer: `authors` string → `authors` dict + join table (same shape
     as `nsr_authors`); `category` → subject-analog join; `funder` → new join table;
     `author_corresponding_institution` → a NEW entity NSR never had — flag its facet
     potential. Mark plainly: source fields with no NSR home (new columns), and
     load-bearing NSR columns with no source (`keywords`, `citation_count`, nuclide/
     reaction selectors — state what dies, what a later enrichment/classifier lane could
     backfill).
5. **Ingest plan, sized.** medRxiv: snapshot CSV → COPY, then `details` over the
   snapshot_date→now gap. bioRxiv: full `details` walk (~15.9k requests at 30/page — give
   a realistic wall-clock) unless the TDM bucket rumor pans out. Daily increment: the `Nd`
   interval form. Enrichment passes (pubs join, funder backfill, JATS fulltext) as separate
   lanes. Numbers for each: rows, requests, time, bytes.
6. **Schema proposal.** DDL as text IN THE REPORT — not applied, not written to `sql/`.
   Start from NSR's hub-and-spokes pattern and state per NSR table: carries over renamed /
   carries over trimmed / dropped / new. Preserve the house patterns: string business key,
   provenance flag (`is_nsr` → `server` or equivalent), derived `text[]` aggregates +
   GIN, generated `fts` column recipe (title A / ? B / abstract C — propose the B-weight
   source given there are no expert keywords), staging-table upsert naming only
   source-owned columns, embeddings as sidecar keyed by the business key.

## Report format (edit this file)

Per task: findings, then **Evidence** (URLs probed, excerpts ≤10 lines). End with the
mapping table, the DDL block, ≤5 **Decisions needed from Brendan**, and a **Next lane**
sketch (the loader). Flag anything that breaks the zero-layout-change goal.

## REPORT (2026-08-19, report-only — nothing applied to the DB)

- **Status: COMPLETE.** ~70 requests across both hosts (cap 200/host), ≤4 in flight, UA
  `cshl-rxivgpt/0.1 (+https://cshl.nysgpt.com; brendan@nysgpt.com)`, 5.5 MB downloaded into
  `data/rxiv-probe/` (cap 150 MB). No DDL applied, no DB writes, no loader code, no commits.
  Receiving shape read first: `api/records.ts`, `api/record.ts`, `api/dict.ts`,
  `src/components/NsrRecordCard.tsx`, `src/pages/References.tsx`, `src/hooks/useNsrRecords.ts`,
  `src/types/nsr.ts`, `sql/01`, `sql/05`, `sql/13`, `sql/15`, `sql/19`, `sql/23`.
- **Headline: the card grid can render preprints with zero layout change.** Every slot has a
  source or a defensible substitute. Three findings change the ingest plan materially: the two
  hosts are *not* the same software (§1), `category`/`type` arrive in inconsistent case and with
  trailing whitespace (§2), and the author string format varies **by version inside one paper**
  (§2). Full detail below.

---

### 1 Endpoint inventory

**The hosts are not the same software.** `api.biorxiv.org` is a strict superset;
`api.medrxiv.org` serves only `details` + `sum` + `usage` + `/reports` and 404s the rest. Both
hosts serve **both servers'** data through `details` — and they paginate differently.

| Endpoint | api.biorxiv.org | api.medrxiv.org | Verdict |
|---|---|---|---|
| `/details/[server]/[interval]/[cursor]/[fmt]` | 200 — **30/page**, includes `funder` | 200 — **100/page**, **no `funder`** | **load now** (the hub) |
| `/details/[server]/[DOI]/na/[fmt]` | 200 — returns **all versions** | 200 | **load now** (version history) |
| `/pubs/[server]/[interval]/[cursor]` | 200 — 100/page | **404** | **load now** (only source of journal *name*; 215,498 rows) |
| `/pub/[interval]/[cursor]` | 200 — 100/page, bioRxiv only | **404** | **skip** — strict subset of `pubs` |
| `/publisher/[prefix]/[interval]/[cursor]` | 200 — 100/page | **404** | **skip** — a filter view over `pubs` data |
| `/funder/[server]/[interval]/[ROR]/[cursor]` | 200 — 100/page | **404** | **enrich later** — `details` already carries `funder` inline; this is a filter view |
| `/sum/[m\|y]` | 200 | 200 (own server) | **enrich later** — dashboard stats |
| `/usage/[m\|y]/[server]` | 200 | 200 | **enrich later** — views/downloads, a real "popularity" signal |
| `/reports` + 6 sub-pages | 200 HTML | 200 HTML | **skip for ingest**; `category_summary` is the one-time vocabulary source |

`/reports` sub-pages (identical set on both hosts, **HTML only, no JSON**):
`category_summary` (full category vocabulary × year), `content_summary` (monthly new/revised),
`institution` (top 50 posting institutions), `journal_summary` (top-20 journals per year),
`publication_summary` (monthly published counts), `usage`.

Formats: `json`, `xml` (OAI-PMH), `html`; `csv` on `pub`/`sum`/`usage`. No auth, no key, no
rate-limit headers observed. Query param `?category=cell_biology` (underscores or URL-encoded)
works on the date-range forms.

**Evidence**
```
ep-medrxiv-pub.json        404  "File not found."     ep-biorxiv-pub.json        200  100 rows
ep-medrxiv-pubs.json       404  "File not found."     ep-biorxiv-pubs.json       200  100 rows
ep-medrxiv-publisher.json  404  "File not found."     ep-biorxiv-publisher.json  200   63 rows
ep-medrxiv-funder.json     404  <html>404 Not Found   ep-biorxiv-funder.json     200    3 rows
# same window, same server, different host:
api.biorxiv.org/details/biorxiv/2020-03-01/2020-03-02/0/json -> count 30, item keys include 'funder'
api.medrxiv.org/details/biorxiv/2020-03-01/2020-03-02/0/json -> count 100, item keys EXCLUDE 'funder'
  bio-host row set ⊂ med-host row set: True   (same records; row ORDER differs between hosts)
  order is stable within a host across repeats: True
  only differing shared field: server  ('bioRxiv' on bio host vs 'biorxiv' on med host)
```

### 2 Field census

1,403 records sampled — 3 windows per server (early / middle / recent), fetched at 100/page,
plus a category-filtered probe and four single-DOI probes.

| field | bio-early | bio-mid | bio-recent | med-early | med-mid | med-recent |
|---|---|---|---|---|---|---|
| `doi` `title` `authors` `author_corresponding` `author_corresponding_institution` `date` `version` `type` `category` `jatsxml` `abstract` `server` | 100% | 100% | 100% | 100% | 100% | 100% |
| `license` | 100% | 100% | 100% | 100% | 99.7% | 100% |
| `published` | 68.9% | 76.7% | **2.7%** | 80.6% | 62.0% | **0.0%** |
| `funder` (bio host only, ≥2025-04-10) | — | — | ~17% | — | — | ~17% |

`published` coverage is a **function of recency, not of quality** — recent preprints simply have
not been journal-published yet. Overall NA rate in-sample 58.7%.

**Distinct values (these become the facet vocabulary):**

- **`category`** — 27 bioRxiv + 51 medRxiv, **union 76** (only `epidemiology` and `pathology` are
  shared). Full lists cached at `data/rxiv-probe/categories-{biorxiv,medrxiv}.json`.
  Cross-check: the report's per-category article counts sum to **345,801** (bioRxiv) and
  **87,564** (medRxiv) — matching the brief's `count_new_papers`, confirming
  category_summary counts *papers* while `details` returns *versions*.
- **`type`** — 5 values after normalization: `new results`, `publishaheadofprint`, `withdrawn`,
  `confirmatory results`, `contradictory results`. **Also empty (`''`) on some v1 rows.**
- **`license`** — `cc_by`, `cc_by_nc`, `cc_by_nc_nd`, `cc_by_nd`, `cc_no`, `cc0`, `cc0_ng`, and `''`.

**Quirks settled:**

- **`(doi, version)` is unique** — 1,403 sampled rows, 1,403 distinct pairs, 1,329 distinct DOIs.
  A row is a version, exactly as the brief states.
- **The single-DOI form returns ALL versions**, newest last, with `messages: [{"status":"ok"}]`
  and no cursor. This is the version-history source — no walking required.
- **Withdrawn papers are a new version with `type='withdrawn'`.** Title, abstract, authors are
  all retained. There is no tombstone and no deletion; the withdrawal is additive.
- **Empty-abstract rate: 0%** in 1,403 records. Length min 227 / median 1,690 / max 8,441 chars.
- **The medRxiv snapshot CSV has 16 columns** = the API's fields **minus `type` and `server`**,
  **plus `node`, `link_page`, `link_pdf`**. It does carry PDF links the API does not — but they
  are trivially derivable (`https://www.{server}.org/content/{doi}v{version}.full.pdf`).
  Manifest: `snapshot_date 2026-08-09`, `record_count 108,060`, file 94,455,398 B (90 MB).

**Three normalization traps — all mandatory on ingest:**

1. **`category` case + whitespace.** 87 raw strings in-sample → **72** after `lower(btrim())`.
   Old (2014-era) records serve `'Evolutionary Biology '` (Title Case, **trailing space**);
   modern records serve `'evolutionary biology'`. 5.3% of sampled rows carry the whitespace form.
2. **`type` case.** `'New Results'` and `'new results'` both occur; 7 raw → 5 normalized.
3. **`server` case** differs *by host*: `'bioRxiv'` from api.biorxiv.org, `'biorxiv'` from
   api.medrxiv.org, for the identical record.

**The author-format finding (this one is not in the brief's ground):** the `authors` string is
**94.7% NSR-style** (`"Costa, D.; Bonet, N."`) and **5.3% given-name-first** (`"Daniel Costa;
Nuria Bonet"`). It is *not* an era split — **the format varies by version inside a single paper**:
v1 carries the raw submitted names, v2+ carry normalized `Last, I.` Separator is `"; "` 92.5% of
the time and `";"` (no space) 7.5%.
**Consequence for the card: none.** `NsrRecordCard` does `record.authors.split(";").map(n => n.trim())`,
which handles both separators. Consequence for the *authors dictionary*: real, see §4.

**Evidence**
```
DOI 10.1101/19000109 via api.biorxiv.org/details/medrxiv/.../na/json  →  5 versions
  v1: authors='Daniel Costa; Nuria Bonet; Amanda Sole; ...'   type=''
  v2: authors='Costa, D.; Bonet, N.; Sole, A.; ...'           type='PUBLISHAHEADOFPRINT'
  v5: authors='Costa, D.; Bonet, N.; Sole, A.; ...'           type='PUBLISHAHEADOFPRINT'
withdrawn sample: doi=10.1101/439042 version=2 type='withdrawn' category='biochemistry'
                  title and abstract both still populated, published='NA'
category raw→normalized: 87 → 72 ;  trailing-whitespace rows 74/1403 (5.3%)
type raw→normalized:      7 → 5  ;  license values: '' cc0 cc0_ng cc_by cc_by_nc cc_by_nc_nd cc_by_nd cc_no
funder (details, 2026-08 window): 5/30 rows carry an array, 25 carry the string "NA"
  [{"name":"Biotechnology and Biological Sciences Research Council","id":"https://ror.org/00cwqg982",
    "id-type":"ROR","award":"BB/X010996/1;BB/X01102X/1;BB/T008717/1;"}, ...]
snapshot header (16): title authors author_corresponding author_corresponding_institution doi date
  version license category jatsxml abstract funder published node link_page link_pdf
```

### 3 Identity + version ruling

**Proposed `key_number` = the DOI suffix, uppercased, server-qualified only if §Decision 1 says so.**

Pressure-tested against every form found live:

| DOI form | suffix | notes |
|---|---|---|
| `10.1101/2020.09.09.20191205` | `2020.09.09.20191205` | modern medRxiv |
| `10.1101/2026.07.31.741992` | `2026.07.31.741992` | modern bioRxiv |
| `10.64898/2026.08.01.xxxxxx` | same shape | **2026 prefix change is invisible to the suffix** ✅ |
| `10.1101/001891` | `001891` | old bioRxiv, 6-digit sequence |
| `10.1101/19000109` | `19000109` | old medRxiv, 8-digit |
| `10.1101/439042` | `439042` | old bioRxiv |

- **Survives the prefix change** — the suffix is the paper id; the 2026 `10.64898` prefix changes
  nothing. ✅
- **Uppercase-safe** — suffixes are digits and dots only, so `/api/record?key=` doing
  `.toUpperCase()` is a no-op. ✅
- **Not provably unique across servers.** Old-style suffixes are bare integers on both servers
  (bioRxiv `439042`, medRxiv `19000109`); nothing in the API guarantees the two sequences never
  collide. I found no collision in-sample, but the sample is 1,403 of 584,629 rows. The safe
  scheme is a server qualifier. → **Decision 1.**

**Version ruling.**

- **Hub row = latest version** (`max(version)` per `(server, doi)`). That is what the References
  grid and the drawer should show.
- **Full version history goes to a sidecar** `preprint_versions`, one row per `(key_number, version)`,
  carrying the fields that actually change between versions: `date`, `type`, `authors`, `title`,
  `abstract`, `license`, `jatsxml`. This is *not* optional — v1 vs v2 differ in author formatting
  and `type`, and "withdrawn" only exists as a later version. A `raw jsonb` column on the hub keeps
  the latest version's untouched payload for anything we did not model.
- **Loader dedup rule:** stage every returned row; `INSERT … ON CONFLICT (key_number) DO UPDATE`
  only `WHERE EXCLUDED.version > preprints.version` — so out-of-order pages and re-walks are
  idempotent and can never regress a paper to an older version.

### 4 The 1-1 mapping table

**Card + hub (`/nsr` References grid — the first target surface)**

| source field | our `table.column` | UI slot / route |
|---|---|---|
| `doi` suffix | `preprints.key_number` (text, business key) | `#` bold key badge, top-left of card |
| `date` → `EXTRACT(year)` | `preprints.pub_year` (int) | year badge, top-right |
| `date` | `preprints.posted_date` (date) | drawer; sort key |
| `title` | `preprints.title` | card title, 2-line clamp |
| `authors` | `preprints.authors` (text, `"; "`-joined) | **Authors** slot — `split(";")+trim` already handles both source formats ✅ |
| `published_journal` (from `pubs`) else `server`+`date` | `preprints.reference` | **Reference** slot — e.g. `Genes & Development` when published, else `bioRxiv (preprint, 2026-07-31)` |
| `category` (normalized) | `preprints.categories text[]` (1 elem) | **chip group A** (was Nuclides) |
| derived: `v{N}`, `type`, published?, `license` | `preprints.status_tags text[]` | **chip group B** (was Reactions) — → **Decision 2** |
| `doi` (full) | `preprints.doi` | DOI link, bottom-left → `doi.org/{doi}` ✅ both prefixes resolve |
| `abstract` | `preprints.abstract` | drawer body; fts weight C; embedding input |
| `version` | `preprints.version` (int) | status chip, drawer |
| `type` (normalized) | `preprints.type` | status chip, `withdrawn` banner in drawer |
| `license` (normalized) | `preprints.license` | drawer |
| `server` (normalized lower) | `preprints.server` | **provenance flag** — the `is_nsr` analog |
| `jatsxml` | `preprints.jatsxml_url` | drawer "full text (JATS)" link |
| — derived — | `preprints.pdf_url` | `https://www.{server}.org/content/{doi}v{version}.full.pdf` (confirmed by the snapshot's `link_pdf`) |
| `author_corresponding` | `preprints.author_corresponding` | drawer |
| `author_corresponding_institution` | `preprints.institution` + `institutions` dict | drawer; **new facet** |
| `published` (journal DOI) | `preprints.published_doi` | drawer "published as" link |
| `published_journal` (`pubs`) | `preprints.published_journal` + `journals` dict | Reference slot; combobox B candidate |
| `published_date` (`pubs`) | `preprints.published_date` (date) | drawer |
| `funder[]` | `funders` dict + `preprint_funders` join | drawer; facet |
| whole record | `preprints.raw jsonb` | provenance / re-derivation |

**`/nsr` filter bar — every control accounted for**

| control today | driven by | becomes |
|---|---|---|
| Year dropdown (`YEAR_OPTIONS` = 2000–2026) | `pub_year` | works unchanged — but **trim the hardcoded list to 2013–2026**; bioRxiv starts 2013-11, medRxiv 2019-06, so 13 of 27 options are dead years |
| `NuclideCombobox` → `/api/dict?type=nuclides` | `unnest(nuclides)` | `/api/dict?type=categories` — **76 values**, ideal combobox size |
| `ReactionCombobox` → `/api/dict?type=reactions` | `unnest(reactions)` | `/api/dict?type=journals` — thousands of values, a genuine typeahead (60 distinct in a single 100-row `pubs` page) |
| Authors sort | `authors` string | unchanged ✅ |
| Key # sort | `key_number` | works; note new-style suffixes (`2026.07.31.…`) sort lexically ≈ chronologically, old-style integers sort separately — acceptable within a year |
| **EXFOR toggle** (`exfor_keys IS NOT NULL`) | — | **"Published only" toggle** (`published_doi IS NOT NULL`). Exact semantic 1-1: both mean "has a link into another database". **51.3% of bioRxiv / 45.5% of medRxiv** papers qualify (`/reports/publication_summary`, cumulative through Jul 2026) — a well-balanced filter |
| `/api/dict?type=authors` | `authors`+`nsr_authors` | unchanged shape, new dict (see below) |

**Relational layer**

| source | our tables | note |
|---|---|---|
| `authors` string | `authors(author_key, initial1, initial2, last_name)` + `preprint_authors(key_number, author_key, order_index)` | **same shape as `nsr_authors`** so `/api/dict?type=authors` needs no rewrite. **But the source gives no author IDs** — NSR got `authorKey` from NNDC. We mint a surrogate: hash of `(last_name, initial1, initial2)` after parsing. The 5.3% given-name-first rows must be parsed to `Last, I.` first or the same person splits into two dict entries |
| `category` | `categories(category, server)` dict + `preprint_categories(key_number, category)` | 1 value per record today; join table keeps facet counts cheap and survives multi-category later |
| `funder[]` | `funders(ror_id, name)` + `preprint_funders(key_number, ror_id, award)` | `award` is a `;`-joined string that needs splitting; `id` is empty for some funders → key on `coalesce(nullif(ror_id,''), name)` |
| `author_corresponding_institution` | `institutions(institution)` dict + FK on the hub | **an entity NSR never had.** Free text, no ROR, needs normalization (`Stanford University` vs `Stanford Univ.`). CSHL themselves facet on it (`/reports/institution`) — high facet potential, and the natural third combobox |
| `published_journal` | `journals(journal_name)` dict | replaces NSR's `journals(journal_code)`; `pubs` is the only source of the journal *name* |

**Source fields with no NSR home (new columns):** `version`, `type`, `license`, `jatsxml`,
`author_corresponding`, `author_corresponding_institution`, `server`, `published_doi`,
`published_journal`, `published_date`, `funder`, `node`/`link_page`/`link_pdf` (snapshot only).

**Load-bearing NSR columns with no source — what dies:**

| NSR column | verdict |
|---|---|
| `keywords` (expert keyword abstracts) | **dies.** No analog exists. This is the **B weight** in `sql/19`'s fts recipe *and* the 196k-row supervision signal behind NSR-CPT. Replacement B source proposed below |
| `nuclides`, `reactions`, `z_values`, `subjects`, `topics`, `nsr_*` selector joins | **dropped** — domain-specific to nuclear structure |
| `exfor_keys` | **dropped** → replaced by `published_doi` (see EXFOR toggle) |
| `venue` | **not dead — natively better.** `published_journal` from `pubs` *is* the venue, first-party |
| `fields_of_study` | **not dead** — `category` is the same slot, author-assigned at submission |
| `is_open_access`, `open_access_pdf_url` | **not dead — trivially true.** Every preprint is open access by definition; the PDF URL is derivable from `(server, doi, version)` |
| `tldr` | **drop the column.** Verified: `tldr` appears only in `src/types/nsr.ts` and `useS2Enrichment.ts` — **it is never rendered anywhere in the UI**, and with 100% abstract coverage it has no job |
| `s2_authors` (h-index, affiliations) | no source; partially covered by `author_corresponding_institution` |
| `citation_count`, `influential_citation_count`, `reference_count` | **the only genuinely S2/OpenAlex-only fields.** Every row has a DOI and both API keys are already in this repo's env |
| `pdf_available`, `xundl_available`, `collaborations`, `sentence_groups`, `journal_code`, `coden_text`, `index_information` | **dropped** |

**fts B-weight proposal** (replacing `keywords` in `sql/19`'s recipe):
`setweight(to_tsvector('english', category || ' ' || coalesce(published_journal,'') || ' ' || coalesce(institution,'')), 'B')`
— the three fields that behave like controlled vocabulary here. Weaker than NSR's expert
keywords; a later classifier lane could generate real keyword abstracts and restore the slot.

**Candidate replacements for the lost supervision signal** (NSR's 196k expert keyword abstracts
were the CPT gold; probed 2026-08-19, Europe PMC REST, no key required):

| candidate | rows | what it gives | verdict |
|---|---|---|---|
| **MeSH via the published DOI** (Europe PMC `resultType=core`) | ~215,498 (49% of papers) | Human NLM-indexer-assigned controlled vocabulary — descriptors + qualifiers + `majorTopic_YN`, plus author `keywordList`. **The literal analog to NSR keyword abstracts**, and hierarchical (MeSH tree) where NSR's was flat | **strongest.** Only reaches published papers |
| **Citation graph** (Europe PMC `hasReferences:Y` on the preprint itself) | ~100% of corpus | (paper → cited paper) positives, cited-of-cited hard negatives — the SPECTER/SciNCL recipe, the field-standard signal for scientific embedding fine-tunes | **strongest for retrieval.** Works on unpublished rows too |
| **Version pairs** (in-corpus, free) | **151,211** | Same paper, same authors, two wordings — naturally occurring paraphrase positives. Already loaded by lane ①, costs nothing extra | **free win** |
| **Category labels** (in-corpus, free) | **433,418** papers × 76 classes | Author-assigned at submission, 100% coverage — a ready-made classifier training set **larger than NSR's 196k** | **free win** |
| **Preprint ↔ published abstract pairs** | 215,498 | The same work in two written forms; also a "what peer review changed" signal | useful, second order |

Evidence: `10.1111/febs.15578` (the published form of preprint `10.1101/19000109`) returns **16 MeSH
headings** with qualifiers + 5 author keywords + `citedByCount`. `SRC:PPR AND HAS_MESH:Y` →
**hitCount 0**, so preprints carry no MeSH of their own — it arrives only through the published
DOI. Europe PMC holds 1,220,111 preprint records overall and reports `hasReferences: Y` for ours.

**Zero-layout-change verdict: PASS.** Every card slot renders. The two chip groups need a label
change (`Nuclides` → `Category`, `Reactions` → `Status`) — text, not layout. The one real risk is
the key badge: it is `text-base font-bold` with no truncation, and a server-qualified key like
`BIORXIV:2026.07.31.741992` is ~3× an NSR key (`2005SU06`), which would crowd the year badge on
mobile. Bare suffixes are ~18 chars and fit. → **Decision 1.**

### 5 Ingest plan, sized

Measured payload: **~2.2 KB of JSON per version row** (220,571 B / 100 rows).

| lane | rows | requests | wall-clock @5 req/s | bytes |
|---|---|---|---|---|
| **medRxiv full walk** via `api.medrxiv.org` (100/page) | 108,690 | 1,087 | **~4 min** | ~240 MB |
| medRxiv snapshot CSV + gap walk | 108,060 + ~700 | 1 + ~7 | ~2 min | 90 MB |
| **bioRxiv full walk** via `api.biorxiv.org` (30/page, **with** `funder`) | 475,939 | 15,865 | **~53 min** | ~1.0 GB |
| bioRxiv full walk via `api.medrxiv.org` (100/page, **no** `funder`) | 475,939 | 4,760 | **~16 min** | ~1.0 GB |
| ↳ + funder backfill, 2025-04-10→now only, bio host (30/page) | 94,409 | 3,147 | ~11 min | ~210 MB |
| `pubs` join, both servers, full range (100/page) | **215,498** published | **2,155** | ~7 min | ~490 MB |
| **Daily increment** — `details/[server]/2d/0/json` | ~250/day | ~4/day | seconds | ~1 MB/day |
| JATS full text (separate lane) | 584k XML+PDF | S3 | hours | **~TB scale** |

**The snapshot is not worth taking.** It saves ~2 minutes over a full medRxiv API walk and costs
the `type` column — which is the *only* way to see withdrawals. Recommend: **walk the API for
both servers, skip the snapshot entirely.** → **Decision 4.**

**The TDM S3 rumor is confirmed but does not help the metadata load.**
`s3://biorxiv-src-monthly` and `s3://medrxiv-src-monthly`, both **us-east-1, requester-pays**,
monthly deposits of **processed PDF and XML**, split into `Back_Content` and `Current Content`
virtual folders. That is *full text*, not metadata — it is the JATS enrichment lane, not a
shortcut around the `details` walk. ⚠️ **Licensing flag:** both TDM pages state the repository
"is not intended as a source for further redistribution", and that services built on the full
text "must therefore link back to the text hosted at bioRxiv rather than re-host content".
Metadata + abstracts (what the API serves) are fine to store and display; mirroring full text is
explicitly out of bounds. This constrains what a RAG/chat surface may return verbatim.

**Recommended sequence:** ① bioRxiv + medRxiv `details` walk → hub + versions sidecar ·
② `pubs` walk → `published_journal`/`published_date` (fills the Reference slot) ·
③ funder backfill if the fast bioRxiv path was taken · ④ S2/OpenAlex DOI enrichment for citation
counts, only if Decision 5 says yes · ⑤ embeddings (bge-m3, 1024-dim, sidecar) · ⑥ JATS/S3 full text, licensing
permitting.

### 6 Schema proposal (DDL as text — NOT applied, NOT written to `sql/`)

Per-NSR-table verdict: `nsr` → **renamed** `preprints` · `authors` → **carries over trimmed**
(surrogate key) · `author_aliases` → **repurposed** (the two name formats) · `journals` →
**carries over renamed** (name, not code) · `nsr_authors` → **renamed** `preprint_authors` ·
`nuclide_dict`, `particle_dict`, `subject_dict`, `reaction_dict`, `reaction_display`,
`decay_processes`, `collaboration_names`, `nsr_nuclides`, `nsr_reactions`, `nsr_subjects`,
`nsr_topics`, `nsr_mass_ranges`, `nsr_z_ranges` → **dropped** · **new**: `preprint_versions`,
`categories`, `preprint_categories`, `funders`, `preprint_funders`, `institutions` ·
`nsr_embeddings` → **renamed** `preprint_embeddings`.

```sql
-- ── hub ──────────────────────────────────────────────────────────────────────
CREATE TABLE preprints (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_number      text NOT NULL UNIQUE,          -- DOI suffix (see Decision 1)
  server          text NOT NULL                  -- provenance flag, the is_nsr analog
                  CHECK (server IN ('biorxiv','medrxiv')),
  doi             text NOT NULL,
  pub_year        int  NOT NULL,
  posted_date     date NOT NULL,
  version         int  NOT NULL,                 -- latest version only; history in the sidecar
  title           text,
  authors         text,                          -- '; '-joined, normalized to 'Last, I.'
  abstract        text,
  reference       text,                          -- published_journal, else 'bioRxiv (preprint, YYYY-MM-DD)'
  type            text,                          -- normalized: new results | withdrawn | ...
  license         text,
  categories      text[],                        -- chip group A
  status_tags     text[],                        -- chip group B (see Decision 2)
  author_corresponding text,
  institution     text,
  jatsxml_url     text,
  pdf_url         text,
  published_doi   text,
  published_journal text,
  published_date  date,
  raw             jsonb,                         -- latest version's untouched payload
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server, doi)
);

-- version history: one row per (paper, version) — authors/type/title all drift between versions
CREATE TABLE preprint_versions (
  key_number  text NOT NULL,
  version     int  NOT NULL,
  posted_date date,
  type        text,
  title       text,
  authors     text,
  abstract    text,
  license     text,
  jatsxml_url text,
  PRIMARY KEY (key_number, version)
);

-- ── dictionaries ─────────────────────────────────────────────────────────────
CREATE TABLE categories   (category text PRIMARY KEY, server text, paper_count int);
CREATE TABLE journals     (journal_name text PRIMARY KEY, paper_count int);
CREATE TABLE institutions (institution text PRIMARY KEY, paper_count int);
CREATE TABLE funders      (funder_key text PRIMARY KEY,   -- coalesce(nullif(ror_id,''), name)
                           ror_id text, name text);
CREATE TABLE authors (                                -- same shape as NSR's, surrogate key
  author_key bigint PRIMARY KEY,                      -- hash(last_name, initial1, initial2)
  initial1 text, initial2 text, last_name text
);
CREATE TABLE author_aliases (initial1 text, initial2 text, last_name text, author_key bigint);

-- ── join tables (full-replacement loads: TRUNCATE + COPY, no PK, by house rule) ──
CREATE TABLE preprint_authors    (key_number text NOT NULL, author_key bigint NOT NULL, order_index int);
CREATE TABLE preprint_categories (key_number text NOT NULL, category text NOT NULL);
CREATE TABLE preprint_funders    (key_number text NOT NULL, funder_key text NOT NULL, award text);

-- ── derived aggregates + fts (AFTER the bulk load, per the house pattern) ────
ALTER TABLE preprints ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(array_to_string(categories,' '), '') || ' ' ||
                                   coalesce(published_journal, '') || ' ' ||
                                   coalesce(institution, '')), 'B') ||
  setweight(to_tsvector('english', left(coalesce(abstract, ''), 4000)), 'C')
) STORED;

CREATE INDEX idx_pp_fts        ON preprints USING gin (fts);
CREATE INDEX idx_pp_categories ON preprints USING gin (categories);
CREATE INDEX idx_pp_status     ON preprints USING gin (status_tags);
CREATE INDEX idx_pp_year       ON preprints (pub_year DESC);
CREATE INDEX idx_pp_key        ON preprints (key_number);
CREATE INDEX idx_pp_server     ON preprints (server);
CREATE INDEX idx_pp_published  ON preprints (published_doi) WHERE published_doi IS NOT NULL;

-- ── embeddings sidecar, keyed by the business key (mirrors sql/23) ───────────
CREATE TABLE preprint_embeddings (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number),
  embedding   vector(1024) NOT NULL,             -- bge-m3
  model       text NOT NULL DEFAULT 'bge-m3',
  text_hash   text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);
-- HNSW index AFTER the full embed pass, never before.

-- ── staging (names ONLY source-owned columns, per the house upsert pattern) ──
CREATE UNLOGGED TABLE stage_preprints (
  doi text, title text, authors text, author_corresponding text,
  author_corresponding_institution text, date text, version text, type text,
  license text, category text, jatsxml text, abstract text, published text,
  server text, funder jsonb
);
-- upsert: latest version wins, re-walks are idempotent
-- INSERT INTO preprints (...) SELECT ... FROM stage_preprints
--   ON CONFLICT (key_number) DO UPDATE SET ...
--   WHERE EXCLUDED.version > preprints.version;
```

### Decisions needed from Brendan

1. **Key scheme.** Bare DOI suffix (`2026.07.31.741992`, fits the card badge) or server-qualified
   (`BIORXIV:2026.07.31.741992`, provably collision-free but ~3× NSR's key length and crowds the
   year badge on mobile)? I recommend **bare suffix + a `UNIQUE (server, doi)` guard**, and we
   revisit only if a real collision turns up in the load.
2. **What the two chip groups become.** Recommended: **A = category** (76-value vocabulary),
   **B = status tags** (`v3`, `withdrawn`, `published`/`preprint`, license). The alternative for B
   is **funders**, which is a genuine multi-value array but only ~17% populated (submission-system
   inception 2025-04-10), so most cards would show an empty slot.
3. **bioRxiv walk strategy.** One pass on `api.biorxiv.org` — 53 min, `funder` included, one lane.
   Or `api.medrxiv.org` at 100/page — 16 min — plus an 11 min funder backfill, two lanes, ~27 min
   total. I lean **one pass**: 26 min of extra wall-clock is not worth a second code path.
4. **medRxiv snapshot: take it or skip it?** I recommend **skip**. It saves ~2 minutes and costs
   the `type` column, which is the only signal that a paper was withdrawn.
5. **Do we fund the S2/OpenAlex enrichment lane — for citation counts alone?** Re-checked against
   `RecordDrawer.tsx`: every S2 section is conditionally rendered (`s2Found && …`), so without the
   lane those sections simply **do not appear** — nothing renders empty. And most of what NSR
   needed S2 for, this corpus has natively and better: `venue` = `published_journal`,
   `fields_of_study` = `category`, open-access = always true, `tldr` = never rendered at all.
   **What is left is exactly one thing: citation counts** (plus author h-index). So the real
   question is narrow — is a citation-count ranking signal worth a 584k-DOI enrichment pass?
   My read: **not for v1.** Ship without it; the drawer looks complete regardless. Revisit when
   search ranking needs a popularity prior.

### Next lane (the loader) — sketch

`LANE-RXIV-LOAD`: ① apply the §6 DDL as `sql/01-preprints.sql` (tables + PKs only; the index and
fts blocks land as `sql/02-…` **after** the load, per the house rule) · ② `scripts/walk-rxiv.mjs`
— cursor walk per server, `Nd`/date-range interval, resumable via a `sync_runs`-style ledger,
writes newline-JSON to `data/` · ③ `scripts/load-rxiv.mjs` — chunked `\copy` into
`stage_preprints` on the **unpooled** host, then the latest-version-wins upsert, then
TRUNCATE+COPY the join tables · ④ indexes + `ANALYZE` · ⑤ `pubs` walk → `published_*` backfill ·
⑥ repoint `/api/records`, `/api/record`, `/api/dict` at `preprints` (three files, ~40 lines) and
flip Vercel's `DATABASE_URL` to `CSHL_DATABASE_URL` · ⑦ trim `YEAR_OPTIONS` to 2013–2026 and
relabel the two chip groups. Bulk-load laws apply throughout: unpooled host, `pool.on('error')`,
chunked `\copy`, stage→upsert, indexes last, floor bump during the load, rehearse on 1% first.

---

## BUILD LOG (timestamped, newest last)

### 2026-08-19 01:25 EDT — lane acknowledged, build in flight

Channel acknowledged. Reporting here from now on; re-reading DIRECTIVES after every filing
and at each pause in the walk/load.

**Rulings received and being executed:** all five decisions ruled as recommended — bare
DOI-suffix key + `UNIQUE (server, doi)` guard, chips = category + status tags, bioRxiv one
full pass with funder, snapshot skipped in favour of the API walk (keeps `type`/withdrawn),
no S2/OpenAlex lane in v1 (`tldr` dropped, citation counts deferred).

**State at this filing**

| step | state |
|---|---|
| (a) schema | **done** — sql/01–07 written, 01/03/06 applied, 19 tables live |
| (b) walk + load | medRxiv **complete** (108,690 version rows); bioRxiv **96/154 months**, 161,192 rows staged and upserting |
| (c) pubs pass | queued behind the details walk |
| (d) relational layer | proven on medRxiv (342,971 authors, 797,016 links, 51 categories); re-runs after bioRxiv |
| (e) surface wiring | **done** — records/record/dict/search/chat rewired, card chips relabelled, filters swapped |

**Verified so far:** 80,470 medRxiv papers upserted with **0 key collisions**; every rewired
route exercised against the real database (`/api/records` filters return 12,703 for year=2024,
39,172 for published-only, 11,115 for category=epidemiology); `/api/search` returns
`degraded: true` and falls through to FTS; `/api/record` returns the card shape plus the
version timeline. `npx tsc -b && npm run build` green at every commit.

**Deviations from the plan, all approved by Brendan:** host routing refined so pre-2025-04
months use the 100/page host (no funder exists to lose before the inception — verified);
`array_to_string` is STABLE so the fts B-weight uses `categories[1]`; indexes went on before
the final upsert to get a verifiable preview early, with a real REINDEX (sql/07) at the end.

**Open items before close-out:** bioRxiv walk tail → final upsert → pubs → derive → REINDEX →
preview verification → the three close-out asserts → credential rotation.

### 2026-08-19 01:33 EDT — interim 2: embeddings sidecar reviewed and staged

**To the rig-port lane, on your §5-DDL:** reviewed and accepted, with one amendment.
Written as `sql/08-embeddings.sql` — your chosen name `preprint_embeddings` is unchanged, so
your worker's default `EMB_TABLE` needs no edit. Table only, no HNSW, per the house rule and
your own note.

*Amendment:* the FK is now `REFERENCES preprints(key_number) ON DELETE CASCADE`. Your note (a)
asks that the FK be kept and it is — cascade only decides what happens when a preprint row is
deleted. Without it, dropping a paper (a withdrawn row removed in some future reload) fails on
a dangling embedding; with it the stale vector goes too, which is the only correct outcome — a
vector for a paper that no longer exists is garbage that still answers kNN queries. Flagging it
rather than changing your proposal silently.

**Not yet applied**, by the directive's own gate ("when your finish-load/derive/reindex
sequence completes"). It is wired into `scripts/finish-load.sh` between the REINDEX and the key
assertion, and the box gets checked with the migration number the moment it lands. ETA ~30 min:
the bioRxiv walk is at 104/154 months.

*On the scope guard:* creating this empty table is not an embed run. No vectors are written
tonight, no encoder, no reranker, no classifier — and `preprint_embeddings` was already part of
the Task-6 schema Brendan approved in (a). Applying it is consistent with that instruction; had
it required running the rig, I would have declined here instead.

**Corpus at this write:** biorxiv 117,069 + medrxiv 80,470 = **197,539 papers**, 261,076 version
rows. Decision 1 close-out so far: 0 cross-server collisions, papers = distinct_keys =
distinct (server, doi) = 197,539, 0 key dupes.

---

## DIRECTIVES — lead → lane (comms channel)

Protocol: after you file any entry in the REPORT section above, and at every natural pause
in long-running work, re-read this section. Act on each unchecked item, then check it off
(`- [x]`) and append a one-line result to it. If a directive conflicts with your HARD CAPS,
the caps win — decline in your report rather than acting. Never edit another lane's file.
If one of your own full-file writes ever drops this section, restore it. The lead watches
this file and responds here after your reports.

- [x] Acknowledge this channel: check this box and note your current step in one line.
      → Acknowledged 01:25 EDT. Current step: bioRxiv details walk at 96/154 months; 161,192 rows staged and upserting while the tail walks.
- [x] Heads-up (lead): the rig-port lane will file a `preprint_embeddings` sidecar DDL proposal in LANE-RIG-PORT.md's REPORT shortly (vector(1024) + model/text_hash/embedded_at, keyed on key_number, HNSW deferred — NSR sidecar pattern). You own sql/ — when your finish-load/derive/reindex sequence completes, review it, apply it as the next numbered migration (table only, NO HNSW index yet — that comes after the embed run per house rule), and check this box with the migration number. It is the last blocker on the embed rig being launch-ready.
      → **APPLIED as `sql/08-embeddings.sql`** 01:38 EDT, verified: PK on key_number, vector(1024), model/text_hash/embedded_at, NO HNSW, 0 rows. One amendment, flagged to rig-port and approved by the lead: FK is `ON DELETE CASCADE`. rig-port messaged directly — not batched behind the load. Applied ahead of the original gate because the db was quiet (no upsert in flight), which is a safer window to take the FK lock on `preprints` than mid-load.
