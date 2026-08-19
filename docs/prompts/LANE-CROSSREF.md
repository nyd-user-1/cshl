# LANE-CROSSREF — abstracts backfill from Crossref

**Free window. Probe ~15 min, sweep ~1–2 h hands-off. You execute; you do NOT commit or push — the lead handles git.**

## Mission
~123k DOI-bearing rows still have no abstract after the S2 pass. Publishers deposit abstracts to Crossref unevenly (APS: yes; IOP/Springer: partly; Elsevier: mostly not) — so **measure per-publisher hit rates first, then sweep only the publishers that pay**.

## Context
- Repo `/Users/brendanstanton/Code/nsr`, Neon via `DATABASE_URL_UNPOOLED` in `.env.local` (unpooled). Copy `psql()`/`csvField`/`csvRow` **verbatim** from `scripts/ingest-aps-feeds.mjs`. Write `scripts/enrich-crossref.mjs`. U+0000 only as an escape sequence, never a literal byte.
- API: `GET https://api.crossref.org/works/{doi}` — no key; ALWAYS send `mailto=brendan@nysgpt.com` (query param or User-Agent) to ride the polite pool. Abstract arrives as JATS XML in `message.abstract` — strip tags, keep text.
- LANE-S2 and LANE-OPENALEX are COMPLETE — no write conflicts. The 43 malformed DOIs are LANE-TEXNORM's problem, skip them.

## Hard rules
0. **UNIQUE-DOI DOCTRINE (added after a live incident):** NSR carries journal-level stub DOIs — 206 DOI values shared by 789 rows — and DOI-keyed writes fan one record onto all of them. Your candidate export and your write-back must BOTH exclude any DOI that maps to more than one `key_number` (`GROUP BY doi HAVING count(*) = 1`). Rows already marked `s2_lookup_status='ambiguous_doi'` are off-limits entirely.
1. **You write ONE column: `abstract`, and only where `abstract IS NULL OR abstract LIKE '%…'`.** No INSERTs, nothing else — not even coalesce columns.
2. **Probe first:** stratified 500-DOI sample across the top publisher prefixes by row count (`SELECT split_part(doi,'/',1), count(*) FROM nsr WHERE doi IS NOT NULL AND abstract IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`). Measure abstract-present rate per prefix. **Paste the table into REPORT before sweeping.** Skip any prefix under 10%.
3. Pace: start at 10 req/s, watch the `X-Rate-Limit-*` headers, back off on 429/503. Cache every response to `data/crossref/` (JSONL shards, not per-DOI files) so a re-run costs nothing.
4. Write-backs: TEMP stage + UPDATE, ≤25k rows/psql, retry ×3. Batch flush every 10k fetched.
5. Blocked >10 min → REPORT, move on.

## Phases
P1 export candidates (doi, key_number where abstract missing) → P2 stratified probe + REPORT gate → P3 sweep the paying prefixes → P4 write-back → P5 verify:
```sql
SELECT count(abstract) AS abstracts, count(*) FILTER (WHERE abstract LIKE '%…') AS teasers FROM nsr;
```
Report abstracts-before vs after, per-prefix yields, requests spent, wall time.

## REPORT (fill in as you go)
- Status:
- P2 per-prefix hit-rate table + which prefixes you swept:
- P5 before/after:
- Wall time / surprises:
