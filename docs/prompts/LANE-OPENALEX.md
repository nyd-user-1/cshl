# LANE-OPENALEX — OpenAlex batch enrichment of the full corpus

**Window 3. Est. 30–45 min total. You execute; you do NOT commit or push — the lead handles git.**

## Mission
Enrich every DOI-bearing row in `nsr` with OpenAlex: OA status + locations, topics, citation counts, arXiv links. ~3,400 API requests. Then measure (sample only) how well OpenAlex can recover DOIs for the ~87k rows that lack one.

## Context you need
- Repo: `/Users/brendanstanton/Code/nsr`. DB: Neon Postgres, `DATABASE_URL_UNPOOLED` in `.env.local` (present; unpooled — keep it).
- `nsr`: ~255,563 rows, ~168,700 with `doi`, ~87k without. `key_number` UNIQUE NOT NULL.
- Write `scripts/enrich-openalex-batch.mjs`. Copy `psql()`, `csvField`, `csvRow` **verbatim** from `scripts/ingest-aps-feeds.mjs`. WARNING: type the NUL character (U+0000) as an escape in regexes — a literal NUL byte makes git treat your file as binary.
- Keys: `grep -E "OPENALEX_API_KEY|OPENALEX_MAILTO" /Users/brendanstanton/Code/44b/.env.local >> /Users/brendanstanton/Code/nsr/.env.local` — both go on the URL as query params (`api_key=`, `mailto=`). Never in argv or committed files.
- Read `/Users/brendanstanton/Code/44b/scripts/ingest-openalex.mjs` header + lines 60–70 before coding: credit economics and the 429 gotcha (**a 429's rate-limit headers lie — judge credit exhaustion only from 2xx responses**).

## Hard rules
1. **Column ownership.** UPDATE only — INSERT nothing. Your columns: `openalex_id`, `oa_status`, `oa_locations`, `openalex_topics`, `openalex_cited_by`. Plus SHARED `arxiv_id` and `pdf_url` — write ONLY as `coalesce(nsr.<col>, <new>)`; two other lanes share them.
2. **Probe first**: one request with 3 known DOIs, confirm response shape, then sweep.
3. Write-backs: TEMP stage + UPDATE, ≤25k rows per psql, retry ×3 (pattern in `ingest-aps-feeds.mjs`).
4. Blocked >10 min → note it in REPORT, move on.

## Phases
**P1 — export.** `SELECT key_number, doi FROM nsr WHERE doi IS NOT NULL`.

**P2 — batch fetch.** `GET https://api.openalex.org/works?filter=doi:D1|D2|...&per-page=50&mailto=...&api_key=...`
- **50 DOIs per pipe-joined filter** (their documented max). URL-encode each DOI. ~3,400 requests.
- This is the list+filter lane = 1 credit/request (~$0.34 total equivalent; free tier is 10k credits/day — you're within it). Pace: 8 req/s max; back off on 429 (remembering its headers lie).
- Save each page to `data/openalex/page-NNNN.json` as you go (crash = no re-spend).
- Response `results[]` — match back to our rows via lowercased DOI (their `doi` field is a `https://doi.org/...` URL — strip the prefix).

**P3 — write back.** `id`→`openalex_id`; `open_access.oa_status`→`oa_status`; `cited_by_count`→`openalex_cited_by`; `locations` where `is_oa`→`oa_locations` (slim: source name, pdf_url, landing_page_url, version); `topics` (slim: display_name, score, field)→`openalex_topics`. `best_oa_location.pdf_url`→`pdf_url` (coalesce). arXiv: `locations` with source id/name arXiv, or `ids`—extract the arXiv id (e.g. from `https://arxiv.org/abs/2408.12345`)→`arxiv_id` (coalesce).

**P4 — verify & report:**
```sql
SELECT count(openalex_id) AS oa_matched, count(oa_status) FILTER (WHERE oa_status <> 'closed') AS any_oa,
       count(pdf_url) AS pdf_urls, count(arxiv_id) AS arxiv_ids, count(openalex_topics) AS topics
FROM nsr;
```

**P5 (stretch, ≤30 min) — DOI-recovery sample.** For 200 random rows with `doi IS NULL AND title IS NOT NULL` (spread across decades: 50 each from pre-1960, 1960–79, 1980–99, 2000+): `GET /works?search=<title>&filter=publication_year:<year>&per-page=1`. Search costs 10 credits/request — 200 requests = 2,000 credits, still inside the free day. Score a hit when the top result's title is a near-exact match AND year matches ±1. Report hit-rate per decade + recommendation on whether full recovery should run via API or via the OpenAlex S3 snapshot on an EC2 instance. DO NOT run beyond the 200 sample tonight.

## REPORT (fill in as you go; the lead polls this file)

**Status: COMPLETE.** P1–P5 all done. Nothing committed, nothing pushed. Zero INSERTs — `nsr` is still 255,563 rows.

Script: `scripts/enrich-openalex-batch.mjs`, phases `--budget | --probe | --fetch | --write | --sweep | --verify | --recover`. `psql()`/`csvField`/`csvRow` copied verbatim from `ingest-aps-feeds.mjs`. Fetched pages cached in `data/openalex/` (3,364 files, 547 MB, gitignored) — a re-run costs 0 credits.

### P2 — requests made / failed / credits picture
| lane | requests | credits | result |
|---|---|---|---|
| budget probe (free singleton) | 1 | 0 | pool read: **10,000/10,000**, resets 16.6h |
| shape probes (2 filter calls, 6 DOIs) | 2 | 2 | all 6 resolved, shape confirmed |
| **P2 filter sweep** | **3,363** | **3,363** | 167,957 works · **0 failed · 0 throttles · 0 retries · 0 errors** |
| free singleton sweep of the misses | 821 | **0** | +64 recovered, 757 genuine 404s |
| P5 search sample | 200 | 2,000 | 3 HTTP 400s (see below) |
| **total** | **4,387** | **5,365** ($0.54) | **4,635 credits left** in today's 10k pool |

- P1 export: 168,747 DOI-bearing rows → 168,117 unique parseable DOIs (24 unparseable, 3 filter-unsafe on comma/pipe). 3,363 requests at 50 DOIs each.
- Held at 8 req/s across 4 workers for 7.1 minutes and OpenAlex never once throttled us, so the 429-header trap never had to fire. The guard is still built the honest way: `remaining` is read only off a 2xx, a 429 only widens the pace gap.
- **Free singleton sweep (added, not in the brief).** 44b's measured lesson is that OpenAlex's DOI *filter* index lags its entity store, so `/works/doi:X` finds works `?filter=doi:X` misses — and the singleton bills 0 credits. Sweeping the 821 filter-lane misses recovered **64 more works for free**; the other 757 are true absences (404). Match rate 99.48% → **99.53%**.

### P4 — verification output
```
 oa_matched | any_oa | pdf_urls | arxiv_ids | topics
------------+--------+----------+-----------+--------
     167949 |  59362 |    51917 |     34569 | 167717

 rows_with_doi | matched          oa_status | count
---------------+---------        -----------+--------
        168747 |  167949         closed     | 108587   green   | 35418
                                 bronze     |  12716   hybrid  |  5619
   99.53% of DOI-bearing rows    diamond    |   4640   gold    |   969
```
- 35.3% of matched rows are open access in some form; 51,917 now carry a PDF URL and 34,569 an arXiv id — both written as `coalesce(nsr.<col>, new)`, so the S2 and arXiv lanes' writes are untouched.
- 167,949 rows carry 167,360 distinct `openalex_id`s: 589 rows share an id with another row, i.e. duplicate DOIs already in NSR. Worth a look, not a defect of this lane.
- Spot check, top-cited rows: `1995MO29 → W2060768354, green, nucl-th/9308022, 3,943 cites, "Astronomical and nuclear sciences"`.

### P5 — DOI-recovery hit-rates by decade + recommendation
200 rows, 50 per era, title search filtered to the exact publication year. Hit = top result's title ≥0.90 token-Jaccard AND year within ±1 AND it carries a DOI. "Near" = ≥0.70.

| era | n | hits | hit-rate | near-miss |
|---|---|---|---|---|
| pre-1960 | 50 | 1 | 2.0% | 9 |
| 1960–79 | 50 | 2 | 4.0% | 7 |
| 1980–99 | 50 | 5 | 10.0% | 4 |
| 2000+ | 50 | 8 | 16.0% | 4 |
| **all** | **200** | **16** | **8.0%** | **24 (12%)** |

**Read 8% as a floor, not the achievable rate.** Three measurable things suppress it, and the first is the big one:

1. **NSR titles are TeX; OpenAlex display names are plain text.** `59% of all DOI-less NSR titles contain $ or {` (pre-1960 48.5%, 1960–79 66.5%, 1980–99 61.9%, 2000+ 52.2%). We sent `Sn$^{117}$*` and `N(*)` straight into a stemmed full-text index — three requests came back HTTP 400 ("a `*` wildcard needs at least 3 leading characters"), which is OpenAlex telling us it read our TeX as query syntax. A TeX-stripping normalizer is the single highest-value fix and it costs nothing to write.
2. **`filter=publication_year:<year>` is exact, so the ±1 year tolerance in the scoring rule is dead on arrival** — a work OpenAlex dates one year off can never be returned. As specified in the brief; worth relaxing to a 3-year range next time.
3. The 24 near-misses (12%) are mostly the same paper with punctuation/markup drift. A real matcher scores title+first-author+journal+volume+page, not title alone.

**And the denominator is much smaller than 87k.** Of 86,816 DOI-less rows: only **62,221 have a title at all**, and by reference type only **38,684 are JOURNAL** — the rest are 25,835 REPORT, 15,540 CONFERENCE, 2,113 THESIS, 2,141 PRIVATE_COMMUNICATION, 364 BOOK. Most of those never had a DOI to recover. The realistic target is ~38.7k journal rows plus 811 preprints, not 87k.

**Recommendation: do it from the S3 snapshot, not the API.** Not close.
- API route: 62,221 title-bearing rows × 10 credits = **622,210 credits ≈ $62** at list price, or 63 days of the free 10k/day tier — to buy a single-shot ~8–20% yield, with every methodology fix (TeX stripping, wider year window, author/volume/page scoring) costing another full re-spend to test.
- S3 route: `s3://openalex/data/works/` is CC0, free, no requester-pays. On one EC2 box in `us-east-1` (transfer free in-region), stream the works snapshot, keep `(normalized_title, year, doi, id)`, and match locally. Zero credits, iteration is free, and you can match on author+journal+volume+page instead of title alone. The same local index also re-answers the 757 filter+singleton misses and serves the arXiv and S2 lanes.
- Sequencing: build the TeX normalizer first and validate it against the 167,949 rows we *already* matched (their true DOIs are known, so title-match precision/recall can be measured offline at zero cost) before spending an EC2 hour on the snapshot.
- **Did not run beyond the 200-row sample, per the brief.**

### Wall time per phase
| phase | time |
|---|---|
| P1 export (168,747 rows via `\copy`) | 2.8 s |
| P2 batch fetch (3,363 requests @ 7.9 req/s) | 7.1 min |
| P3 write-back (7 chunks × 25k, TEMP stage + UPDATE) | 3.0 min (+3.5 min for the sweep re-run) |
| free singleton sweep (821 DOIs) | 1.7 min |
| P4 verify | 3 s |
| P5 recovery sample (200 searches) | 1.0 min |
| **total** | **~21 min** wall, ~35 min including build and debug |

### Surprises / blockers
- **The NUL-byte warning in the brief is real and it bit immediately.** Typing the NUL in `csvField`'s regex produced a file `file(1)` called `data` and `grep` refused to search. Fixed to the `\u0000` escape; the file is text now. Flagging it because the failure is invisible until git or grep tells you.
- **`\copy` must be on ONE line.** P5 crashed with `\copy: parse error at end of line` because the 4-bucket sampling query was joined with newlines. `psql` meta-commands do not span lines — the `UNION ALL` joins are now single-line. Cost: one restart, no credits.
- **Deviated from the brief on `per-page`, deliberately.** The brief says `per-page=50` alongside 50 DOIs per filter. 44b measured that a DOI filter can return *more* works than values given (merged/duplicate works sharing a DOI: 100 DOIs → count 101), so at `per-page == batch` the overflow silently falls off page 1. Set `per-page=100`, same 1 credit, with a page-2 fallback if `meta.count` still exceeds the page.
- **The brief's "50 DOIs is their documented max" is off by half.** OpenAlex documents up to **100** values per `|` filter, and 44b runs at 100. I stayed at 50 as instructed — but 100 would have halved this to 1,682 requests and 1,682 credits. Worth changing before any re-run.
- `openalex_id` is stored short (`W2060768354`), not as the full `https://openalex.org/W...` URL, matching 44b's `paper_metadata.openalex_id` so the two corpora join without a rewrite.
- The 3 filter-unsafe DOIs (comma or pipe in the value) initially fell out of the miss list entirely. Fixed: they stay in the DOI map and route to the free singleton lane, so they are counted and retried rather than silently dropped.
- No blocker ran past 10 minutes. Zero throttles, zero API errors on the 3,363-request sweep.
