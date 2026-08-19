# LANE-ENSDF-ARCHIVE — mirror every ENSDF distribution + load the current snapshot

**Free window. Setup ~20 min; downloads run hands-off; parse+load ~30 min. You execute; you do NOT commit or push — the lead handles git.**

## Mission
NNDC publishes the full ENSDF database as archival distributions back to 2004 at `https://www.nndc.bnl.gov/ensdfarchivals/`. Three jobs: (1) mirror EVERY distribution file to S3, (2) parse the LATEST snapshot into Neon — one row per ENSDF dataset with its full card deck — and (3) extract the NSR key-number references from every dataset, linking ENSDF ↔ our literature corpus.

## Context
- Repo `/Users/brendanstanton/Code/nsr`, Neon via `DATABASE_URL_UNPOOLED` in `.env.local` (unpooled). psql helpers verbatim from `scripts/ingest-aps-feeds.mjs`. Write `scripts/ingest-ensdf-archive.mjs`. NUL warning: write U+0000 only as an escape sequence — and STRIP real NULs from archive text before COPY (jsonb/text reject them).
- File listing (already fetched): `data/ensdf-archivals.json` — same shape as NSR's archivals (`distributions[].{year, files[]}`). Download URL pattern (same site framework as nsrarchivals): `https://www.nndc.bnl.gov/ensdfarchivals/distributions/dist{YY}/{file}` — **verify with one HEAD request first**; if 404, discover the right pattern from the page's `js/ui.js`.
- AWS CLI is configured. Bucket `nsr-pdfs` exists; use prefix `s3://nsr-pdfs/archivals/ensdf/{year}/{file}`.
- **DEVICE RULE: nothing lands on laptop disk beyond one zip at a time in the scratchpad** (`/tmp` is fine for the single working zip; delete after each). Stream downloads → S3 via `curl -s <url> | aws s3 cp - <s3key>` where possible.
- Reference for what "right" looks like: the About page states current ENSDF holds **20,121 datasets for 3,445 nuclides** — your P2 counts should land near that.

## Hard rules
1. **You own three tables outright** (create + load): `ensdf_datasets`, `ensdf_refs`, `ensdf_archive_files`. You touch NOTHING else. `nsr` is read-only.
2. NNDC politeness: serial downloads, ≥1 s between files.
3. Save DDL as `sql/20-ensdf-datasets.sql` matching EXACTLY:
```sql
BEGIN;
DROP TABLE IF EXISTS ensdf_datasets, ensdf_refs, ensdf_archive_files;
CREATE TABLE ensdf_archive_files (   -- the S3 mirror ledger
  year int NOT NULL, file text NOT NULL, s3_key text NOT NULL, bytes bigint
);
CREATE TABLE ensdf_datasets (
  nucid    text NOT NULL,            -- ENSDF NUCID, e.g. '137CS'
  a        int,
  element  text,
  dsid     text NOT NULL,            -- dataset ID string, e.g. 'ADOPTED LEVELS, GAMMAS'
  dsref    text,                     -- keynumber refs from the ID record
  pub      text,                     -- publication field
  entry_date text,                   -- ID-record date field (as-is)
  num_cards int,
  raw      text NOT NULL             -- the dataset's full 80-column card deck
);
CREATE TABLE ensdf_refs (            -- ENSDF ↔ NSR literature links
  nucid text NOT NULL, dsid text NOT NULL, key_number text NOT NULL
);
COMMIT;
-- after load:
-- CREATE UNIQUE INDEX idx_ensdf_ds ON ensdf_datasets (nucid, dsid);
-- CREATE INDEX idx_ensdf_a ON ensdf_datasets (a);
-- CREATE INDEX idx_ensdf_refs_key ON ensdf_refs (key_number);
-- CREATE INDEX idx_ensdf_refs_ds ON ensdf_refs (nucid, dsid);
-- ANALYZE ensdf_datasets, ensdf_refs, ensdf_archive_files;
```
   (If (nucid, dsid) turns out non-unique in the real data, report the collision examples and make the index non-unique — do not dedupe silently.)
4. **Probe first**: download ONE zip, list its contents, paste a 15-line excerpt of one dataset (the ID record + a few cards) into REPORT before writing the parser.
5. Blocked >10 min → REPORT it, move on.

## Phases
**P1 — mirror.** Enumerate every file in `data/ensdf-archivals.json` (all years). Stream each to S3, record in `ensdf_archive_files`. Report: file count, total GB, any 404s.

**P2 — parse + load the LATEST distribution.** ENSDF format facts you need (verify against your probe): a distribution unpacks to text files of 80-column card images; **datasets are separated by blank lines**; each dataset begins with an IDENTIFICATION record — NUCID in cols 1–5, DSID in cols 10–39 (may continue on a second ID card), DSREF (keynumber list) cols 40–65, PUB cols 66–74, date cols 75–80. NUCID like ` 137CS` → `a=137`, `element='CS'`. Split on blank-line boundaries, extract the ID fields, store the whole deck in `raw` (strip NUL/CR). Chunked COPY ≤2k datasets per psql (raw is bulky), retry ×3.

**P3 — literature links.** Across each dataset's full deck, regex all NSR key numbers (`\b(19|20)\d{2}[A-Z]{2}\d{2}\b` — plus the `-E00`-suffixed erratum form), dedupe per dataset → `ensdf_refs`. Then measure the join: how many distinct key_numbers, and what fraction exist in `nsr.key_number`. That match-rate is the headline number of this lane.

**P4 — verify + report.**
```sql
SELECT (SELECT count(*) FROM ensdf_datasets) AS datasets,
       (SELECT count(DISTINCT nucid) FROM ensdf_datasets) AS nuclides,
       (SELECT count(*) FROM ensdf_refs) AS ref_links,
       (SELECT count(DISTINCT key_number) FROM ensdf_refs) AS distinct_keys,
       (SELECT count(DISTINCT r.key_number) FROM ensdf_refs r JOIN nsr n ON n.key_number = r.key_number) AS keys_in_corpus;
```
Compare datasets/nuclides to the 20,121 / 3,445 reference. Apply the index block. Report wall times per phase + surprises.

## REPORT (fill in as you go; the lead polls this file)
- **Status: COMPLETE — all four phases green.** 357/357 files mirrored (5.34 GB, zero failures); 20,120 datasets and 198,295 literature links loaded; **corpus match-rate 99.926 %**. Nothing committed, nothing pushed — `sql/20-ensdf-datasets.sql` and `scripts/ingest-ensdf-archive.mjs` are sitting in the working tree for the lead. One deviation and one decision are flagged below (index name; the spec regex's letter-tail blind spot).

### P1 — URL pattern + probe

**URL pattern CONFIRMED as given**, no `js/ui.js` archaeology needed:
`https://www.nndc.bnl.gov/ensdfarchivals/distributions/dist{YY}/{file}`

HEAD-probed one file per era, including the extensionless oddballs — all 200:

| probe | HTTP | Content-Length |
|---|---|---|
| `dist26/ensdf_260805.zip` | 200 | 42,463,827 |
| `dist04/Ensdf.upd` | 200 | 15,108,201 |
| `dist04/ensdf_0403_070.zip` | 200 | 3,917,441 |
| `dist05/A_1_99` (no extension) | 200 | 20,830 |
| `dist06/dsid.upd` | 200 | 87,642 |
| `dist09/ensdf.066` | 200 | 619,245 |
| `dist11/ensdf.031.msg` | 200 | 5,876 |
| `dist12/ensdf_120307_099.zip` | 200 | 9,673,577 |
| `dist17/ensdf_170501.099.zip` (dot, not underscore) | 200 | 11,844,896 |
| `dist18/xundl_181001.all` | 200 | 56,997,351 |
| `dist21/ensdf_210701_199.zip` | 200 | 21,362,392 |
| `dist25/ensdf_251201.zip` | 200 | 42,165,039 |

**Probe zip** — `ensdf_260805.zip`, 42.5 MB, unpacks to **300 members** `ensdf.001 … ensdf.300` (one per mass number A), 265,455,987 bytes uncompressed. No CR, no NULs, exactly 1 line longer than 80 columns in the whole distribution.

15-line excerpt, `ensdf.137`, dataset `137CS ADOPTED LEVELS, GAMMAS` (ID record + following cards):

```
137CS    ADOPTED LEVELS, GAMMAS                                  07NDS    200709
137CS  H TYP=ERR$AUT=J. Tuli$DAT=17-Dec-2007$COM=fixed typos noted by PNPI$
137CS  H TYP=FUL$AUT=E. BROWNE, J. K. TULI$CIT=NDS 108,2173 (2007)$
137CS2 H CUT=1-Oct-2006$
137CS  Q 1175.63   188278.2  197405.6  4 -3084   5     2012WA38
137CS cQ $Note: Current evaluation has used the following Q record
137CS2cQ 1175.63   17 {I8278}.2 {I19} 7409    7 -3084    5   2003Au03
137CS c  Theory: 2000Yo08, 1998Su03, 1993Ch31
137CS c  Isotope Shifts: 2000Ga58, high-resolution resonant laser spectroscopy
137CS c  |g-ray source properties: 2000He14
137CS c  References where {+137}Cs is used as the standard source, such as, for
137CS2c  various calibrations, etc., and not in study of {+137}Cs structure,
137CS3c  have not been included.
137CS cG $|g ray data are from either 1977We02 or 1999Br17,
137CS2cG unless noted otherwise.
```

A second ID record showing the DSREF/PUB/DATE columns populated (`ensdf.270`):
```
270DB    274BH A DECAY (44 S)          2010Og01,2013OG04,2014KH0419NDS    201902
```

**Format facts verified against the probe** (all as the brief described):
- NUCID cols 1–5 (`137CS`, `137IN`, or mass-only `137` for the per-chain COMMENTS/REFERENCES datasets), DSID cols 10–39, DSREF cols 40–65, PUB 66–74, date 75–80. Slicing on those exact columns reproduces every field.
- Datasets are blank-line separated; the first card of each block is the ID record (cols 6–9 blank). A whole-distribution scan found **20,120 blocks, 20,120 of them with a well-formed ID record, 0 malformed** — no continuation ID cards anywhere in this snapshot (checked: no block's second card has blank cols 6–9).
- **Watch item found in the probe:** DSREF fills its 26 columns exactly and then runs flush into PUB with no separator — `...2014KH0419NDS`. A key-number regex with a trailing word boundary silently loses that last key. The parser therefore takes refs from two sources and unions them: the fixed-column DSREF field (split on commas) **plus** the boundary-anchored regex over the whole deck.
- Key numbers in the cards are frequently **mixed case** (`2010Og01`, `2003Au03`, `1977We02`); NSR stores them uppercase (verified: every `is_nsr` key in the corpus is uppercase), so extracted keys are upper-cased before the join.

**P1 mirror totals — complete: 357 files, 5.34 GB, 0 missing, 0 failed, 0 retries.**

Every file in `data/ensdf-archivals.json` across all 23 distributions (2004–2026) is now at `s3://nsr-pdfs/archivals/ensdf/{year}/{file}`, and `ensdf_archive_files` reconciles with S3 exactly — **357 objects / 5,337,585,913 bytes on both sides**, no zero-byte objects. Nothing touched laptop disk: each file streamed `curl → aws s3 cp -`, and the one working zip lived in the scratchpad and was deleted after the parse. Serial, ≥1 s apart, ~9 s/file end to end.

| year | files | size | | year | files | size |
|---|---|---|---|---|---|---|
| 2004 | 11 | 74 MB | | 2016 | 7 | 77 MB |
| 2005 | 16 | 73 MB | | 2017 | 31 | 357 MB |
| 2006 | 12 | 64 MB | | 2018 | 34 | 426 MB |
| 2007 | 13 | 82 MB | | 2019 | 19 | 271 MB |
| 2008 | 10 | 118 MB | | 2020 | 28 | 337 MB |
| 2009 | 19 | 156 MB | | 2021 | 12 | 147 MB |
| 2010 | 15 | 130 MB | | 2022 | 12 | 457 MB |
| 2011 | 17 | 128 MB | | 2023 | 12 | 462 MB |
| 2012 | 15 | 129 MB | | 2024 | 12 | 470 MB |
| 2013 | 15 | 133 MB | | 2025 | 12 | 479 MB |
| 2014 | 15 | 101 MB | | 2026 | 8 | 323 MB |
| 2015 | 12 | 96 MB | | **total** | **357** | **5.34 GB** |

The mirror is resumable: it inventories the S3 prefix first and skips anything already uploaded, so a re-run after an interruption costs only the missing files.

### P2 — parse + load of the latest distribution

`2026/ensdf_260805.zip`, 300 members, parsed and loaded in **280 s / 12 chunks**:

| | |
|---|---|
| datasets loaded | **20,120** (reference: 20,121) |
| distinct NUCIDs | 3,729 |
| — of which real nuclides (element present) | **3,443** (reference: 3,445) |
| — of which mass-chain-only rows (`137 COMMENTS` / `137 REFERENCES`) | 286 |
| cards stored | 3,276,986 |
| datasets carrying a DSREF | 15,253 |
| `ensdf_datasets` on disk | 75 MB (265 MB of card images, TOAST-compressed) |
| **skips** | **0** — every block produced a row |

Zero malformed records: 0 blocks with an unusable NUCID, 0 with a non-numeric mass, 0 datasets merged by a missing blank-line separator (checked directly: no stored deck contains an interior ID-shaped card). The 1-dataset / 2-nuclide gap against the About-page reference is snapshot drift, not parse loss — the About page is a rolling number and this is the 2026-08-05 zip.

### P3 — literature links + corpus match-rate

**198,295 dataset↔key links, 55,305 distinct key numbers, 55,264 of them present in `nsr` — a 99.926 % match rate.** From the other side: ENSDF cites **21.65 %** of the 255,315-row NSR corpus.

All **41** unmatched keys are ENSDF-side data quality, not parser error — verified by pulling the citing card for each:

| miss | citing card | what it is |
|---|---|---|
| `2004ZN14` | `152    R 2004ZN14   *** MISSING ***` | ENSDF's own REFERENCES record flags it missing from NSR (9 such markers in the snapshot) |
| `1913ZH10` | `91RU D  ADDED 1913Zh10;` | year typo (1913 predates the corpus; almost certainly 2013Zh10) |
| `1962MA00` | `20F cL T$Weighted av: ... (1962Ma00)` | sequence `00` is not a valid NSR number |
| `1928GU10` | `18NA c  See other analyses in (1928Gu10, 1984An18,` | year typo |

### P4 — verification output

```
 datasets | nuclides | ref_links | distinct_keys | keys_in_corpus
----------+----------+-----------+---------------+----------------
    20120 |     3729 |    198295 |         55305 |          55264
```

`(nucid, dsid)` collisions: **0** → the index was created **UNIQUE** as specified. Index block applied, then `ANALYZE`.

**One deviation, flagged not silenced:** the spec's `CREATE INDEX idx_ensdf_a ON ensdf_datasets (a)` cannot be used — `idx_ensdf_a` is already taken by `sql/18-ensdf-xundl.sql` on `ensdf_index`, and Postgres index names are schema-unique. Mine is **`idx_ensdf_ds_a`**; `sql/20-ensdf-datasets.sql` carries the same rename with a comment saying why. Everything else in the DDL is verbatim.

### Wall time / surprises

| phase | wall |
|---|---|
| probe (download + format scan + column verification) | ~6 min |
| P2+P3 parse + load (single pass, 12 chunks) | 280 s |
| P4 verify + 4 indexes + ANALYZE | ~40 s |
| P1 mirror (357 files, backgrounded alongside P2–P4) | ~57 min |
| **total lane wall time** | **~1 h 10 min** |

**Surprises worth the lead's attention:**

1. **The spec regex has a real blind spot, and it is expensive.** NSR also mints key numbers whose last two characters are *letters* — `2002BAZN`, `1989MUZZ` — 61,330 of them in our corpus (24 %). `\b(19|20)\d{2}[A-Z]{2}\d{2}\b` cannot match those. Measured cost: **7,142 additional distinct keys and 21,012 additional dataset↔key links are being left on the floor, and 99.5 % of those keys are already in `nsr`.** That is +13 % distinct keys and +11 % links for a one-character regex change (`\d{2}` → `[A-Za-z0-9]{2}`). I did **not** apply it — P3 specifies the regex and the match-rate is this lane's headline number, so changing the definition unilaterally would make the number incomparable. Say the word and it's a one-line diff plus a 5-minute reload.
2. **DSREF runs flush into PUB with no separator** when it fills all 26 columns: `...2010Og01,2013OG04,2014KH0419NDS`. A boundary-anchored regex silently drops that third key. The parser reads the DSREF field by fixed columns *and* regexes the deck, then unions — otherwise the loss is invisible.
3. **Key numbers in ENSDF cards are mixed case** (`2010Og01`, `1977We02`) while NSR stores them upper. Matching case-sensitively would have collapsed the match rate; extraction upper-cases.
4. **No DSID continuation cards exist in this snapshot** — 0 of 20,120 datasets. 93 ID cards do fill column 39, so a future distribution could truncate a DSID; worth a re-check on the next monthly load rather than a speculative continuation parser now.
5. `20,120` vs the About page's `20,121` and `3,443` vs `3,445` is snapshot drift; the parse is lossless against the zip that was actually downloaded.

**Files written** (uncommitted, as instructed): `sql/20-ensdf-datasets.sql`, `scripts/ingest-ensdf-archive.mjs`. Nothing else touched; `nsr` was read-only throughout.
