# LANE-OA-FETCH — turn 23,506 PDF addresses into PDFs we hold

**Free window. Setup + measurement ~30 min; the fetch then runs hands-off (hours — that's fine, it's unattended). You execute; you do NOT commit or push — the lead handles git.**

## Mission
`pdf_url` is an address; `pdf_stored` is a file we hold. 23,506 rows have an address but no file, spread over 387 hosts. Fetch them all into `s3://nsr-pdfs/oa/`, verifying every byte-stream is actually a PDF. Also: first, rescue the 1,684 SCOAP³ PDFs stranded on laptop disk into S3.

## Context
- Repo `/Users/brendanstanton/Code/nsr`, Neon via `DATABASE_URL_UNPOOLED` (unpooled). psql helpers verbatim from `scripts/ingest-aps-feeds.mjs`. Write `scripts/fetch-oa-pdfs.mjs`. U+0000 only as an escape.
- S3 bucket `nsr-pdfs` exists (us-east-1); AWS CLI + SDK creds are configured on this machine. LANE-ARXIV's `scripts/arxiv-pdf-s3/worker.mjs` shows the stream-to-S3-without-touching-disk pattern — reuse it.
- **UNIQUE-DOI DOCTRINE applies** to any DOI-keyed logic; safer here — key everything by `key_number` (your worklist carries it).
- **DEVICE RULE: zero files land on laptop disk.** Stream response body → S3 PutObject. Memory footprint stays small (one part in flight per worker).

## Hard rules
1. Columns you may write: `pdf_stored` (only where NULL), nothing else. No INSERTs.
2. **Verify before writing back**: response must start with `%PDF` magic bytes AND be >10 KB. HTML login pages saved as .pdf are worse than nothing — count them as failures by class.
3. **Politeness is per-host**: serial within a host, ≥1.5 s between requests to the same host; global concurrency ≤12 across different hosts. Respect 429/403 by backing off that host (2 strikes → park the host, report it). Send a real User-Agent with mailto:brendan@nysgpt.com.
4. **Measure before committing to a route.** Publisher hosts sometimes block datacenter IPs, so the laptop's residential IP may outperform EC2 here. Take a 200-URL stratified sample (top 10 hosts by volume + long-tail mix), run it from the laptop (streaming to S3), report success rate by host. If a top host fails hard from here, note it — the lead decides whether to try EC2 for that host.
5. Progress + resume: JSONL log shipped to `s3://nsr-pdfs/logs/oa/` every 1k; worklist query is naturally resume-safe (`pdf_stored IS NULL`). Write back in 1k batches so progress is visible in the DB.
6. Blocked >10 min → REPORT, move on.

## Phases
**P0 — SCOAP³ rescue.** `aws s3 sync data/pdfs/scoap3/ s3://nsr-pdfs/scoap3/` → verify count matches → UPDATE those rows' `pdf_stored` from local path to the s3 key → delete the local files → report GB freed.

**P1 — worklist + host census.** `SELECT key_number, pdf_url FROM nsr WHERE pdf_url IS NOT NULL AND pdf_stored IS NULL`. Report the top-15 hosts by count — that distribution decides everything (if one host is half the worklist, its pacing sets the wall time; say so with numbers).

**P2 — 200-URL measured sample** (rule 4). REPORT gate: paste the success table before the full run.

**P3 — full fetch.** Stream to `s3://nsr-pdfs/oa/<key_number>.pdf` (key_number is unique and join-safe; sanitize `/` → `_`). Log every outcome with a failure class: `ok | http_4xx | http_5xx | not_pdf | too_small | timeout | host_parked`.

**P4 — write-back + verify.**
```sql
SELECT count(pdf_stored) AS pdfs_held, count(pdf_url) AS addresses,
       count(*) FILTER (WHERE pdf_url IS NOT NULL AND pdf_stored IS NULL) AS still_missing FROM nsr;
```
Report yield %, failure-class breakdown, GB added to S3, and the parked-host list.

## REPORT (fill in as you go)
- Status:
- P0 SCOAP³ rescue (files, GB freed):
- P1 top hosts:
- P2 sample success table:
- P3/P4 yield + failure classes + parked hosts:
- Wall time / surprises:
