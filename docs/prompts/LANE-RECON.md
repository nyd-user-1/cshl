# LANE-RECON — size the remaining resources (report-only)

**Free window. HARD CAP: 30 minutes per resource, ~90 min total. Report-only: NO code, NO DB writes, NO downloads over 50 MB. You do NOT commit or push.**

## Mission
Brendan flagged these resources. For each: what is it, is there bulk/API access, what would it ADD to a corpus that now holds all of NSR (255k entries, enriched via S2/OpenAlex/Crossref), all of EXFOR (27k entries, linked), 92k nuclear arXiv records, and ~35k PDFs in S3 — and a sized go/no-go recommendation. An honest "adds nothing, skip" is a valid and valuable verdict.

## Resources
1. **PhySH** — APS's Physics Subject Headings taxonomy. `https://physh.org/apis` + the SwaggerHub spec (`apis/apsphysics/physh/1.0.0`). Questions: can we bulk-pull the full taxonomy (concepts + hierarchy)? Are APS articles queryable by PhySH concept? Would PhySH concepts improve our topic layer beyond OpenAlex topics + NSR selectors? Deliverable: taxonomy size, access method, and whether a nuclear-physics subtree exists worth importing as a dictionary table.
2. **CINDA** — `https://www-nds.iaea.org/exfor/cinda.htm`. The historical index to neutron-data literature. Questions: is its content already inside NSR+EXFOR (we can test: does it index pre-1970 reports absent from our corpus? sample 20 entries and check against our DB via the NSR web search or key patterns)? Is there bulk access? Deliverable: overlap verdict + whether it holds unique pre-1970 literature pointers.
3. **IAEA-NDS applications-data page** — `https://www-nds.iaea.org/pages/applications-data`. Catalog what's listed; flag anything bibliographic or PDF-bearing we don't already have (we HAVE: EXFOR, ENDF reports table, NSR). Most entries will be evaluated-data libraries — note them for the far-future data phase, don't dwell.
4. **IAEA publications feed** — `https://www.iaea.org/feeds/publications` (+ the IAEA publications site). Questions: does it carry nuclear-science technical reports (INDC series etc.) with PDFs? Volume? Bulk access? Deliverable: what a monthly pull would add vs our endf_reports + NSR REPORT-type entries.
5. **IAEA-NDS GitHub** (`https://github.com/IAEA-NDS`) — we already ingested `exfor_json`. Scan the org for anything ELSE bibliographic/corpus-relevant (e.g. `exfor_dictionary`, `ripl3_json`, `ndlab`). One line each: keep/skip.

## Report format (edit this file)
Per resource: **What it is · Access (API/bulk/none) · What it adds to us · Effort · Verdict (build now / build later / skip) · Evidence** (URLs probed, sample responses ≤10 lines).

## REPORT (fill in as you go)
- Status:
- 1 PhySH:
- 2 CINDA:
- 3 applications-data:
- 4 IAEA publications:
- 5 IAEA-NDS GitHub:
