# LANE-S2 — Semantic Scholar batch enrichment of the full corpus

**Window 2. Est. 30–45 min total. You execute; you do NOT commit or push — the lead handles git.**

## Mission
Enrich every DOI-bearing row in the `nsr` table with Semantic Scholar metadata via the batch API: full abstracts, TLDRs, citation counts, open-access PDF URLs, and arXiv IDs. ~340 API requests total. When done, run the CHORUS recon (stretch).

## Context you need
- Repo: `/Users/brendanstanton/Code/nsr`. DB: Neon Postgres. Connection: `DATABASE_URL_UNPOOLED` in `.env.local` (already present). It is the UNPOOLED host — keep it that way.
- `nsr` table: ~255,563 rows; ~168,700 have `doi`. `key_number` is UNIQUE NOT NULL.
- Write scripts as `scripts/enrich-s2-batch.mjs`. Copy the `psql()`, `csvField`, `csvRow` helpers **verbatim** from `scripts/ingest-aps-feeds.mjs` (they exist and are battle-tested tonight). WARNING: when writing the NUL character (U+0000) in a regex, type the escape — a literal NUL byte in source makes git treat the file as binary.
- API key: run once (idempotent-ish; check for dupes):
  `grep "SEMANTIC_SCHOLAR_API_KEY" /Users/brendanstanton/Code/44b/.env.local >> /Users/brendanstanton/Code/nsr/.env.local`
  Never put the key in argv, code, logs, or this file.

## Hard rules
1. **Column ownership.** You UPDATE existing rows only — you INSERT nothing. You may write ONLY these columns: `s2_paper_id`, `abstract`, `tldr`, `citation_count`, `influential_citation_count`, `reference_count`, `venue`, `is_open_access`, `open_access_pdf_url`, `s2_authors`, `fields_of_study`, `s2_lookup_status`, `s2_looked_up_at` — plus the two SHARED columns `arxiv_id` and `pdf_url`, which you must write as `coalesce(nsr.arxiv_id, <new>)` / `coalesce(nsr.pdf_url, <new>)` (first-writer-wins; two other lanes share them).
2. **Abstract rule:** overwrite when `abstract IS NULL OR abstract LIKE '%…'` (the trailing-ellipsis ones are truncated APS-feed teasers; replace them). Never overwrite a full abstract.
3. **Probe first.** One batch request with 3 known DOIs (e.g. `10.1103/PhysRevC.109.054908`), print the JSON shape into your terminal, confirm field names, THEN run the sweep.
4. Write-backs go through a TEMP stage table + one UPDATE per chunk (≤25k rows per psql invocation), exactly the `ingest-aps-feeds.mjs` pattern. Retry each psql ×3.
5. If any step blocks you >10 min, write the blocker into REPORT below and continue with what you can.

## Phases
**P1 — export.** `SELECT key_number, doi FROM nsr WHERE doi IS NOT NULL` → memory or a local JSONL. (~168.7k rows.)

**P2 — batch API.** `POST https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract,tldr,citationCount,influentialCitationCount,referenceCount,externalIds,isOpenAccess,openAccessPdf,venue,authors`
- Body: `{"ids": ["DOI:10.1103/...", ...]}` — **500 ids per request**, header `x-api-key`.
- Pace: **1100 ms between requests** (44b's proven pace). On 429/5xx: sleep 10 s, retry, max 5; then record the batch as failed and move on.
- Response array is positional (null for misses). Save raw responses to `data/s2/batch-NNN.json` as you go so a crash never re-spends API calls.
- ~340 requests ≈ 7–10 min.

**P3 — write back.** Per the ownership + abstract rules. Misses get `s2_lookup_status='not_found'`, hits `'ok'`; both get `s2_looked_up_at=now()`. `externalIds.ArXiv` → `arxiv_id` (coalesce). `openAccessPdf.url` → both `open_access_pdf_url` (yours) and `pdf_url` (coalesce).

**P4 — verify & report.** Run and paste into REPORT:
```sql
SELECT count(*) FILTER (WHERE s2_lookup_status='ok') AS s2_ok,
       count(*) FILTER (WHERE s2_lookup_status='not_found') AS s2_miss,
       count(abstract) AS abstracts, count(tldr) AS tldrs,
       count(arxiv_id) AS arxiv_ids, count(pdf_url) AS pdf_urls
FROM nsr;
```

**P5 (stretch, ≤30 min) — CHORUS recon.** https://www.chorusaccess.org is an OA-location aggregator publishers (incl. APS) feed directly. Find its public API (start at chorusaccess.org / api docs), probe it with 5 of our DOIs that still have `pdf_url IS NULL`, and measure the hit rate on a 200-DOI sample. Do NOT run it corpus-wide yet — report the measured hit rate and your recommendation.

## REPORT (fill this in as you complete phases; the lead polls this file)

- **Status: COMPLETE — all of P1–P5 done. Nothing committed, nothing pushed.**
  Script is `scripts/enrich-s2-batch.mjs` (`export|fetch|write|verify|all`, every phase resumable).
  Untracked artefacts left behind: `data/s2/` (337 raw batch JSONs, 331 MB, gitignored),
  `data/s2/{dois.csv,fetch*.log,write.log,fetch-summary.json}`. `.env.local` gained
  `SEMANTIC_SCHOLAR_API_KEY` (one line, appended once, verified no dupe).

- **P1 export — done, 2.1 s.** 168,747 DOI-bearing rows → 168,101 unique DOIs.
  43 DOIs (0.026%) are malformed and were skipped, e.g. `10..1140/epja/...`,
  `10.1140\epjst\...` (backslash), `10.1016/j.nuclphysa.2020.121815 get`,
  `https://dx.doi.org/10.1088/...`, `doi:10.1515/ract-2024-0302`, `110.1140/...`,
  `10.1086/`. These are dirty in the source dump, not a parse bug — a DOI
  normalisation pass at ingest would recover ~30 of them. Not my lane's column.

- **Probe (hard rule 3) — done.** Field shapes confirmed against the live API:
  `paperId`, `externalIds.{ArXiv,DOI,CorpusId}`, `venue` (can be `""`),
  `referenceCount`, `citationCount`, `influentialCitationCount`, `isOpenAccess`,
  `openAccessPdf.{url,status,license}` (`url` can be `""`), `tldr` is an OBJECT
  `{model,text}` (not a string), `authors[{authorId,name}]`. Misses come back as
  positional `null`. I added `fieldsOfStudy` to the field list — the lane's field
  string omitted it but `fields_of_study` is an owned column and it costs nothing.

- **P2 requests made / failed — done, 31 min wall (1,675 s + 190 s recovery).**
  337 batches of 500, **0 failed after recovery**, 168,101 DOIs all accounted for:
  **163,000 hits / 5,101 misses = 97.0% hit rate.** 298 batch POSTs issued across the
  two passes (44 were already cached from the first run and cost nothing), plus 171
  retry requests absorbed by 429s and by the split-and-conquer recovery.
  Raw responses in `data/s2/batch-000..336.json`; summary in `data/s2/fetch-summary.json`.

- **P3 write-back — done, 6 min.** 7 chunks of ≤25k stage rows,
  **168,704 nsr rows updated** (more than the 168,101 stage rows because duplicate
  DOIs in `nsr` all receive the same enrichment through the `lower(doi)` join).
  Every psql invocation succeeded first try — no retries used.

- **P4 verification output** (run 04:00, immediately after the write-back):
  ```
   s2_ok  | s2_miss | abstracts | tldrs | arxiv_ids | pdf_urls
  --------+---------+-----------+-------+-----------+----------
   163446 |    5258 |     45523 | 13260 |     38096 |    61115
  ```
  ⚠️ **Read the last two columns as corpus totals, not as my contribution.** They are
  the two SHARED columns and LANE-ARXIV was writing them at the same time — I re-read
  `arxiv_id` five minutes later and it had gone 38,096 → **86,245**, of which 48,541
  sit on rows I never marked `ok`. That column is the arXiv lane's, moving live.
  `pdf_url` at the same moment: 61,138 total, only 1,227 of them on non-`ok` rows, so
  `pdf_url` is effectively all mine for now.

  Against the pre-run baseline I captured before touching anything, with what S2
  itself actually supplied (counted straight off the 337 raw batch files) so my share
  is unambiguous:

  | column | before | after (04:00) | S2 supplied a value for | attribution |
  |---|---|---|---|---|
  | `s2_lookup_status='ok'` | 0 | 163,446 | 163,000 DOIs | all mine |
  | `s2_lookup_status='not_found'` | 0 | 5,258 | 5,101 DOIs | all mine |
  | `abstract` | 19,941 | 45,523 | 44,765 DOIs | **+25,582**, mine |
  | `tldr` | 2,796 | 13,260 | 13,242 DOIs | **+10,464**, mine |
  | `open_access_pdf_url` | 41,980 | 74,819 | 59,179 DOIs | **+32,839**, mine |
  | truncated `…` abstracts | 453 | 267 | — | −186, mine |
  | `pdf_url` *(shared)* | 0 | 61,115 | 59,179 DOIs | ~all mine, coalesced |
  | `arxiv_id` *(shared)* | 0 | 38,096 → 86,245 | 34,956 DOIs | **joint with LANE-ARXIV** |

  ("S2 supplied" counts unique DOIs; the corpus columns run a few hundred higher
  because duplicate-DOI rows — 168,704 rows updated from 168,101 stage rows — each
  receive their own copy.)

  Other owned columns after the run: `s2_paper_id` 163,637 · `citation_count` 164,595 ·
  `s2_authors` 163,531 · `fields_of_study` 154,560 · `venue` 56,195 · `is_open_access`
  true on 59,854. (Those exceed the 163,446 `ok` count by the few hundred rows that
  carried legacy values my `coalesce` deliberately preserved.)

  Reconciliation: 168,747 DOI rows = 168,704 written + 43 malformed-DOI rows skipped.
  Of those 43, 24 still have `s2_lookup_status IS NULL` and 19 kept a legacy status.
  The 267 abstracts still ending in `…` are rows where S2 returned no abstract at all —
  the rule says never wipe, so the APS teaser correctly survives.

  Spot check of `10.1103/PhysRevC.109.054908` (2024AA07) end to end: `s2_paper_id`,
  `arxiv_id=2311.09985`, full abstract replacing the teaser, `reference_count=56`,
  `venue='Physical Review C'`, `is_open_access=t`, `pdf_url` = `open_access_pdf_url` =
  the APS PDF link, `fields_of_study={Physics}`, `s2_lookup_status=ok`. Correct.

- **CHORUS findings (P5) — done, ~14 min, run concurrently with the P2 sweep.
  Recommendation: do NOT build a CHORUS lane for `pdf_url`.**
  - **There is no DOI-lookup endpoint.** The only public API is the Funding Agency
    Dashboard Service v1.1 (spec PDF: `chorusaccess.org/wp-content/uploads/Funding-Agency-Dashboard-Service-API-v1.1-082123.pdf`).
    Base `https://api.chorusaccess.org/v1.1/`, four GET endpoints, all keyed by
    **funder agency id**, none by DOI: `/agencies/:id/histories`,
    `/agencies/:id/publishers`, `/agencies/:id/histories/:yyyy/:mm/:dd` (or `/current`),
    `/agencies/:id/publishers/:memberId`. Query params `category`
    (`publicly_accessible|archive|license|total_acceptable`), `subcategory`
    (`yes|unknown`), `limit`, `offset`, `If-Modified-Since`. No auth needed. So the
    lane spec's "probe it with 5 of our DOIs" is not expressible against this API —
    the only access pattern is *enumerate a funder's whole work set and join locally*.
  - **The records carry no PDF URL.** `URL` is just `dx.doi.org/<DOI>`; the closest
    thing to full text is `agency_portal_url`, an OSTI PAGES / PAR landing page
    (e.g. `http://www.osti.gov/pages/biblio/1102957`), not a PDF. What CHORUS
    genuinely adds is an audited OA *status* + date + `license_type`/`licenseUrl`
    (e.g. `AM` + `link.aps.org/licenses/aps-default-accepted-manuscript-license`).
  - **Measured overlap** (live pull, 2,000 publicly-accessible records per slice,
    joined on `lower(doi)`):

    | slice | CHORUS total | sampled | in NSR | % in NSR | matched rows lacking `open_access_pdf_url` |
    |---|---|---|---|---|---|
    | DOE × APS | 29,694 | 2,000 | 337 | 16.9% | 5 |
    | NSF × APS | 31,969 | 2,000 | 205 | 10.3% | 2 |
    | DOE × all publishers | 109,703 | 2,000 | 58 | 2.9% | 2 |

  - **The decisive measurement, re-run after P3 filled `pdf_url`** — of the 600
    sampled CHORUS records that matched an NSR row, how many still lack a `pdf_url`
    that CHORUS could supply:

    | slice | matched in NSR | still no `pdf_url` after S2 | marginal gain |
    |---|---|---|---|
    | DOE × APS | 337 | 2 | 0.6% |
    | NSF × APS | 205 | 28 | 13.7% |
    | DOE × all publishers | 58 | 0 | 0% |

    **30 of 600 matched records — 5% — are rows S2 did not already cover**, and even
    for those CHORUS hands back an OSTI/PAR landing page, not a PDF. Extrapolating the
    two APS slices to their full sets (29,694 + 31,969 records, ~125 paginated requests)
    yields roughly 480 landing-page leads corpus-wide.
  - Verdict: **park it.** The cost is ~125 requests per funder×publisher slice for
    ~480 landing pages we would still have to scrape. arXiv and OpenAlex/Unpaywall
    dominate it — CHORUS's own `auditSource` on these very records is literally
    `"Unpaywall"`, so we would largely be buying Unpaywall data at one remove.
    The one thing worth remembering: `agency_portal_url` → OSTI PAGES is a real
    DOE-funded full-text fallback (OSTI exposes a `/servlets/purl/<id>` PDF route),
    so if a later lane wants DOE full text, go to **OSTI directly**, not via CHORUS.

- **Wall time per phase:** setup + key + schema check ~4 min · probe ~3 min ·
  P1 export 2.1 s · **P2 sweep 31 min** (28 min main pass + 3 min failed-batch
  recovery) · P3 write-back 6 min · P4 verify <1 min · P5 CHORUS ~14 min
  (run concurrently with P2, so it cost no extra wall time).
  **Total ≈ 47 min**, against the lane's 30–45 min estimate; the overrun is entirely
  P2, which the lane sized at 7–10 min — see surprise 1.

- **Surprises / blockers:**
  1. **S2 429s at the documented pace.** Even with the API key and 1100 ms spacing,
     roughly one request in three answers 429 (the *unauthenticated*-pool message,
     though the key is definitely being honoured — the same key returns 200 on GET).
     The lane's "10 s sleep, retry" recovers every time but doubles wall time, so I
     replaced the flat sleep with a graduated backoff (2/5/10/15/20 s). Sweep went
     from ~7.5 s/batch to ~5 s/batch. Restart cost nothing — batch files are cached
     to `data/s2/batch-NNN.json` and a rerun skips them, so no API call is re-spent.
     The lane's 7–10 min estimate for P2 assumes the 1100 ms pace is actually
     sustainable; in practice it is not, and 31 min is the realistic number for a
     168k-DOI sweep. Budget accordingly for the next lane that uses this key.
  2. **The batch endpoint silently drops ids — positional mapping is not safe.**
     5 batches came back with 499 objects for 500 ids. The response array is
     positional, so a length mismatch poisons the entire batch and there is no way
     to tell *which* id vanished. The first version burnt 5 retries and abandoned all
     500 DOIs (2,500 lost). Fixed with retry-once-then-halve-and-recurse; the rerun
     isolated the culprits in 190 s and recovered every batch. The two ids S2 drops
     are **`10.1103/physrevc.30.464`** and **`10.1103/physrev.117.1044`** — both are
     valid DOIs that resolve fine on the single-paper GET endpoint, so this is an S2
     batch-endpoint bug, not bad data on our side. They are recorded as `not_found`;
     a future lane could pick them up via GET.
  3. **`tldr` is an object, not a string** — writing it straight through would have
     put `[object Object]` in the column. Caught by the probe.
  4. **`s2_lookup_status` was not empty before this run.** It already held values
     from a legacy Elsevier enrichment (`found`, `elsevier_not_found`). My baseline
     check only counted `'ok'`/`'not_found'` (both 0), which hid this. My sweep
     overwrote those legacy values on every DOI it looked up — legitimate under
     rule 1, which gives me the column, but the lead should know the column has two
     historical meanings and that 19 rows still carry the Elsevier vocabulary. If
     that matters, the column wants a `source` companion or a value-prefix convention.
  5. **`s2_authors` is capped at 500 authors per paper** by the batch endpoint.
     254 rows sit exactly at 500 and are therefore truncated author lists (large
     collaborations — LHCb, ALICE, STAR). Do not treat `jsonb_array_length(s2_authors)`
     as a true author count for those rows.
  6. **Two deviations from the lane spec, both deliberate:**
     (a) I added `fieldsOfStudy` to the requested field list — the spec's field string
     omitted it although `fields_of_study` is listed as an owned column; it is free on
     the same request and now fills 154,560 rows. (b) For owned columns I used
     `coalesce(s.<new>, nsr.<old>)` rather than a blind overwrite, so an S2 null never
     wipes a value a previous run had put there (this is what preserved 41,980 legacy
     `open_access_pdf_url` rows). `abstract` follows the lane's explicit rule instead,
     and the two shared columns are `coalesce(nsr.<old>, s.<new>)` as instructed.
  7. **The shared-column protocol held, but it makes corpus counters unattributable.**
     First-writer-wins did its job — no lane clobbered another, and I saw no lock
     contention against LANE-ARXIV writing the same rows. The side effect is that
     `count(arxiv_id)` and `count(pdf_url)` are now joint totals of at least two lanes
     running at once, so any lane reporting them as its own delta will overstate.
     Whoever consolidates tonight's lanes should attribute from each lane's own raw
     payload (as I did in P4), not from a corpus-wide `count()`.
