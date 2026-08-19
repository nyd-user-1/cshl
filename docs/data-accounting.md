# NSR Data — Ground Truth Accounting

_Established 2026-08-16, by querying every live store and sweeping the full NNDC dump. Supersedes all record counts in `architecture-report.md` (which describes the February build and claims "88,000+")._

## ✅ 2026-08-16: FULL CORPUS LOADED

The complete NNDC corpus now lives in Neon: **255,315 entries, 1857–2026, exact per-year parity with the 2026-06-30 dump.** Load took 13 minutes (rehearsed on the pre-1950 slice first). Database size after: 2.31 GB (~$0.80/mo).

- Schema: `sql/13-full-corpus-schema.sql` (widened `nsr` + 17 relational tables), `sql/14-full-corpus-indexes.sql` (applied post-load)
- Loader: `scripts/load-nsr-dump.mjs` (chunked psql `\copy`, unpooled host, stage→upsert; ON CONFLICT names only NSR-source columns so embeddings/S2 enrichment are structurally untouchable)
- Compute scaling: `scripts/neon-scale.mjs` (floor 2 CU for the load, back to 0.25 after)
- Verified: `pdf_available` 189,962, `is_primary` 194,001, all join tables exact to source line counts; the 46,289 surviving embeddings + all S2 fields untouched. Two NNDC-retired erratum keys from the Feb era (`2013KO07-E00`, `2012NA04-E00`) were deleted for exact parity.
- Coverage now: title 90.3% · DOI 66.0% · keywords 81.0% · nuclide arrays (from real selectors, not regex) 79.6% · **embeddings 18.1%** · abstracts 7.6% — the enrichment + embedding passes are the next missions.

## Where the data lives

| Store | Contents | Status |
|---|---|---|
| **Neon `nsr`** (project `sparkling-moon-06542876`, db `neondb`) | **255,315 rows, 1857–2026 — the full corpus** | **Home.** |
| Supabase `stsumwwmyijxutabzice` | Old 46,292 rows (2010–2026); **nothing reads it any more** — the client moved fully to Neon `/api/*` routes 2026-08-17 (LANE-PERF Phase 1, commit `2b93ab4`) | Dead — safe to delete (env vars `VITE_SUPABASE_*` removal pending) |
| Supabase `BNLgpt` (`wdgtzqdsxpkeshpdtmji`) | 100-row test stub from Feb | Dead, delete anytime |

Why the old DB was 2010+ only: the February load hit Supabase's storage cap; 2000–2009 was cut. Neon has no such constraint.

### Pre-load state, for the record (Neon, measured 2026-08-16 before the load)

- 46,292 rows, 2010–2026. Embeddings: 46,291 — OpenAI `text-embedding-3-small`, 256-dim, over title+keywords
- DOI: 96.8% · S2-enriched: 90.7% · Abstract: 42.1% · TLDR: 6.0% · regex-parsed nuclides: 56.6%
- `exfor_entries` was never migrated to Neon

## The source: NNDC monthly full dumps

`https://www.nndc.bnl.gov/nsrarchivals/` — listing at `distributions/files.json`, files at `distributions/dist{YY}/{file}`. Published monthly in two formats: `nsr-json_YYYYMMDD.zip` (~326 MB) and `nsr-exchange_YYYYMMDD.zip` (~142 MB). Current: **2026-06-30**. Downloaded to `data/` (gitignored); inventory via `scripts/inventory-dump.py` → `data/inventory.json`.

The JSON dump is a **complete relational export**, not just records:

```
nsr/
├── entries/YYYY/KEYNUM.json     255,315 files — full per-entry JSON
├── tables/                      flat, COPY-ready join tables
│   ├── reference-table.jsonl    255,315 — per-entry citation metadata (type, journal, DOI, dates, flags)
│   ├── text-table.jsonl         255,308 — keyNumber → titleText + keywordText (the embed text)
│   ├── nuclide-table.jsonl    1,210,113 — keyNumber → {z, n, a, element, role: TARGET/DAUGHTER/…}
│   ├── author-table.jsonl     1,404,442 — keyNumber → authorKey + orderIndex
│   ├── subject-table.jsonl      686,880 · reaction-table.jsonl 229,143 · topic-table.jsonl 214,376
│   └── atomic-mass/number tables
├── dictionaries/                journals (606), nuclides (10,043), subjects, particles,
│                                authors (128,190 names + 7,565 aliases), collaborations
├── radioactivity/               reactions.jsonl (incident/outgoing particles, ΔZ/ΔN/ΔA, fission/transfer flags)
└── web/                         nuclide-ids, reaction-codes, author-name-strings
```

## Full-corpus inventory (2026-06-30 dump)

**255,315 entries, 1857–2026.** 194,001 primary · 61,314 non-primary · 1,238 errata (`-E00`) files.

| Field | Coverage |
|---|---|
| Title | 90.3% |
| Authors | 91.8% (canonical `authorKey` per author) |
| **PDF available at NNDC** | **74.4% (189,962 papers)** |
| Structured keyword abstract (`sentenceGroups`) + selectors | 81.0% |
| Nuclide selectors (typed Z/N/A + role) | 79.6% |
| DOI | 66.0% |
| Reaction selectors | 50.9% |
| EXFOR keys | 8.4% · XUNDL 2.7% · Collaborations 3.0% |

By type: 201,586 journal · 25,896 report · 21,044 conference · 2,141 private comm. · 2,113 thesis · 815 preprint · 385 book.

By decade: 1850s–1940s ≈ 2,473 · 1950s 7,730 · 1960s 22,187 · **1970s 54,731 (peak)** · 1980s 38,312 · 1990s 39,739 · 2000s 42,722 · 2010s 30,928 · 2020s 16,493.

_(Historical note: an earlier draft said "we hold ~18% of the corpus" here — that described the pre-load February state and was left in by mistake. The full corpus has been loaded since 2026-08-16; see the headline above.)_

## Fields the February load threw away

The old loader (`scripts/load-nsr-json.py`) kept 8 flat fields and regex-guessed nuclides/reactions from keyword text. The dump actually provides, per entry:

- `referenceType`, `journalCode`, `indexInformation` (volume/page), `codenText` — never captured
- `entryDate`, `modificationDate`, `isPrimary` — never captured
- `authors[].authorKey` — canonical author identity (kills the ILIKE author search)
- `collaborations` (e.g. LHCb's 1,102-author papers)
- `sentenceGroups` — keyword abstracts as *typed structures* (topic; phrase types REACTION/MEASURED/DEDUCED; LaTeX format flag)
- `nuclideSelectors` with exact **Z, N, A, element, role** — the regex parser this replaces achieved 56.6% coverage; the real field covers 79.6% with perfect fidelity
- `reactionSelectors`, `subjectSelectors`, `atomicMass/NumberSelectors`
- `pdfAvailable` / `xundlAvailable` flags, `errataEntries`

## Enrichment reality check

- Abstracts/TLDRs/citations come from **Semantic Scholar, not NSR** — coverage will crater when the corpus 5×es, until an enrichment pass runs. The historical tail will hit at lower rates; complement with OpenAlex, arXiv, Crossref, et al. (scripts exist in `/Code/44b`).
- Embeddings for keyword-less entries (19% of corpus) will be title-only.
- Embedding compute moves to our own AWS setup (not OpenAI, not Titan) — write-up in `/Code/44b`. The OpenAI account is unfunded; the key hardcoded in the old `embed-nsr.py` is dead weight and that script is scheduled for replacement.

## Sequence

1. **Load the full corpus into Neon** (relational: entries + join tables + dictionaries), preserving existing embeddings/S2 fields on the 46k rows we have
2. Enrichment sweep — DOI, abstract, PDF, everything, for every entry (44b's scholarly-API scripts)
3. Embeddings on AWS
4. Evals, fine-tuning
5. Later, deliberately: API layer off Supabase edge functions; index re-tuning for 250k+
