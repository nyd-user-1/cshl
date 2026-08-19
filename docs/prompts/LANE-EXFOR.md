# LANE-EXFOR — rebuild the EXFOR layer from IAEA-NDS/exfor_json

**Free window, start immediately. Est. 30–45 min (clone dominates). You execute; you do NOT commit or push — the lead handles git.**

## Mission
The corpus has `exfor_keys` on 21,423 NSR entries but the `exfor_entries` table was never migrated to Neon. Rebuild it properly from IAEA's own JSON export — the complete EXFOR library, cloned once, no rate limits — plus a join table linking NSR entries to EXFOR datasets.

## Context you need
- Repo: `/Users/brendanstanton/Code/nsr`. DB: Neon, `DATABASE_URL_UNPOOLED` in `.env.local` (unpooled — keep it). Copy `psql()`, `csvField`, `csvRow` **verbatim** from `scripts/ingest-aps-feeds.mjs`. Write `scripts/ingest-exfor.mjs`. NUL warning: write U+0000 only as an escape sequence, never a literal byte.
- Source: `https://github.com/IAEA-NDS/exfor_json` (~1 GB). `git clone --depth 1` into `data/exfor_json/` (data/ is gitignored). If the clone crawls, the codeload tarball is the fallback: `https://codeload.github.com/IAEA-NDS/exfor_json/tar.gz/refs/heads/main`.
- February's `scripts/load-exfor.py` fetched per-file from GitHub raw — read it for the key-format handling, then ignore its approach; the clone replaces it.
- Prior schema sketch (Supabase-era): `sql/04-exfor-entries.sql`. Superseded by the DDL below.

## Hard rules
1. **You own two tables outright** (create + truncate + load): `exfor_entries`, `nsr_exfor`. You touch NOTHING on `nsr` — read-only there.
2. **Probe first**: read ONE entry JSON from the clone and paste its top-level shape (keys + one subentry's keys) into REPORT before writing the parser. Also probe our key format: `SELECT exfor_keys FROM nsr WHERE exfor_keys IS NOT NULL LIMIT 5;` — note the separator and whether keys carry subentry suffixes.
3. Save your DDL as `sql/17-exfor-entries.sql` matching EXACTLY:
```sql
BEGIN;
DROP TABLE IF EXISTS exfor_entries, nsr_exfor;
CREATE TABLE exfor_entries (
  exfor_id        text PRIMARY KEY,   -- 5-char accession number, e.g. '22742', 'C1234'
  title           text,
  year            int,
  authors         text,               -- '; '-joined, NSR style
  institutes      jsonb,
  reactions       jsonb,              -- the REACTION codes across subentries
  num_subentries  int,
  raw             jsonb NOT NULL      -- the full entry JSON
);
CREATE TABLE nsr_exfor (
  key_number text NOT NULL,           -- NSR entry
  exfor_id   text NOT NULL
);
COMMIT;
-- indexes AFTER load, appended in the same file below a marker comment:
-- CREATE INDEX idx_nsr_exfor_key ON nsr_exfor (key_number);
-- CREATE INDEX idx_nsr_exfor_exfor ON nsr_exfor (exfor_id);
-- ANALYZE exfor_entries, nsr_exfor;
```
   (jsonb for institutes/reactions on purpose — no Postgres array literals in CSV, ever.)
4. Loads: TEMP-stage-free is fine here (fresh tables, plain `COPY table FROM STDIN WITH (FORMAT csv)`), chunks of ≤10k entries per psql (raw jsonb is heavy), retry ×3.
5. Blocked >10 min → REPORT it, move on.

## Phases
**P1 — clone + probe.** Clone, count files, paste the entry shape + our `exfor_keys` sample into REPORT.

**P2 — load `exfor_entries`.** Parse every entry file: extract the fields above (map from the actual shape you probed — REACTION codes typically live per-subentry in the BIB section; collect distinct ones). `raw` = the whole entry. Load ALL entries, not just NSR-linked ones (the library is ~25k entries; whole thing or nothing). Report loaded count vs file count, with skips itemized.

**P3 — build `nsr_exfor`.** `SELECT key_number, exfor_keys FROM nsr WHERE exfor_keys IS NOT NULL` → split on the separator you probed, strip whitespace/subentry suffixes so the id matches `exfor_entries.exfor_id`, load pairs. Report: pair count, distinct NSR keys, distinct EXFOR ids, and the orphan count both ways (keys pointing at EXFOR ids we don't have; note examples).

**P4 — indexes + verify.** Apply the index block from sql/17. Then paste into REPORT:
```sql
SELECT (SELECT count(*) FROM exfor_entries) AS entries,
       (SELECT count(*) FROM nsr_exfor) AS links,
       (SELECT count(DISTINCT key_number) FROM nsr_exfor) AS nsr_with_exfor,
       (SELECT count(*) FROM nsr_exfor x LEFT JOIN exfor_entries e USING (exfor_id) WHERE e.exfor_id IS NULL) AS orphan_links;
```

## REPORT (fill in as you go; the lead polls this file)

- **Status: COMPLETE — all four phases green.** 27,070 EXFOR entries loaded (0 skips), 23,515 NSR↔EXFOR links, **0 orphan links**. Artifacts: `sql/17-exfor-entries.sql`, `scripts/ingest-exfor.mjs`. Nothing committed or pushed; `nsr` untouched. One decision waiting on you: `raw` is 90% numeric `data_tables` — see the flag at the foot of this report.

### P1 — clone + probe

Clone: `git clone --depth 1 https://github.com/IAEA-NDS/exfor_json data/exfor_json` — succeeded first try, no tarball fallback needed. **27,073 files checked out, 27,070 of them `json/*/*.json`** (the other 3 are LICENSE / README / the `json` dir itself). Layout is `json/<first-3-chars-of-accession>/<accession>.json`, 341 subdirs.

Size, and this is the surprise of the lane: **2.06 GB of pretty-printed JSON**, median entry 15 KB, p90 74 KB, p99 1.0 MB, **max 94 MB** (`json/145/14508.json`). See "surprises" below.

**Top-level entry shape** (probed on `json/227/22742.json`):

```
entry                    string   "22742"          <- the 5-char accession
last_updated             string   "2025-08-14"
number_of_revisions      string   "7"
histories                array[6] [{x4_code, free_txt[]}]
bib_record               object   {title, authors, institutes, references, facilities}
reactions                object   keyed by subentry: {"002": …, "004": …, "005": …}
data_tables              object   keyed by subentry: {"001","002","004","005"}
experimental_conditions  object   keyed by subentry: {"001","002","004","005"}
```

`bib_record`:
```
title       string
authors     [{name: "M.Diakaki"}, …]                 -> joined with "; " (NSR style)
institutes  [{x4_code: "(2GRCTUA)", free_txt: [...]}]
references  [{x4_code: "(J,PR/C,93,034614,2016)", free_txt: [], publication_year: "2016", doi: null, pointer: "0"}]
facilities  [{x4_code: "(SYNCY,2ZZZCER)", facility_type: "(SYNCY)", institute: "(2ZZZCER)", free_txt: [...]}]
```

One subentry of `reactions` (`reactions["002"]`), keyed by pointer:
```json
{"0": {"x4_code": "(93-NP-237(N,F),,INT)",
       "math_expression": null,
       "children": [{"target":"93-NP-237","process":"N,F","sf49":",,INT","sf6":"INT",
                     "x4_code":"(93-NP-237(N,F),,INT)"}],
       "operator": null, "free_text": "", "pointer": "0"}}
```
So the canonical REACTION string is the per-pointer `x4_code`; `children` is its decomposition (used only for compound codes). I collect the distinct `x4_code`s across all subentries × pointers, paren-stripped, sorted.

Note subentry 001 appears in `data_tables`/`experimental_conditions` but not in `reactions` — 001 is the entry-level common subentry. `num_subentries` is therefore the **union** of keys across `reactions` + `data_tables` + `experimental_conditions` (4 for 22742), not the length of any one of them.

**Our `exfor_keys` format** — cleaner than feared:

```
 key_number |  exfor_keys
------------+--------------
 1963RI09   | A1398
 1962JA09   | 11827; 13662
 1989SH36   | 41041
 2023WA35   | 32918
 2010YA11   | E2283
```

Separator is `'; '`. 21,423 NSR rows carry the column; splitting on `;` yields **24,276 tokens, and every single one is exactly 5 characters and matches `^[A-Z0-9]+$`** — zero tokens with subentry suffixes, zero punctuation, zero stray separators (`exfor_keys ~ '[^A-Za-z0-9; ]'` → 0 rows). So the id matches `exfor_entries.exfor_id` directly; the only normalisation needed is `trim()` (+ a defensive `toUpperCase()`).

### P2 — load `exfor_entries`

**27,070 loaded / 27,070 files. Zero skips.** No parse errors, no id/filename mismatches, no duplicate accessions, no retries fired.

```
P2 done in 433s: 27070 loaded / 27070 files
  source text 2.06 GB; sent compact 0.78 GB; without data_tables 195 MB
```

Field coverage across all 27,070 rows:

| field | populated | the 100%-shortfall, explained |
|---|---|---|
| `title` | 26,912 | 158 entries carry `bib_record.title` as an **empty string** in the source — verified in `raw`, not a parser miss |
| `year` | 27,055 | 15 entries have no reference with a parseable `publication_year` |
| `authors` | 27,067 | 3 entries have an empty author list |
| `institutes` | 27,068 | 2 entries have no INSTITUTE code |
| `reactions` | 25,911 | 1,159 entries have a `reactions` object with **zero subentry keys** in the source — genuinely no REACTION code (monitor/misc entries) |
| `num_subentries` | 27,070 | zero entries came out at 0, so the union-of-keys rule holds everywhere |

`year` spans **1934** (`14696`, Chadwick-era "The Emission and Scattering of Neutrons") to **2026** — both ends sane. `institutes` and `reactions` are proper jsonb **arrays** in every populated row (no scalar/object leakage). `raw` round-trips the whole entry: `raw ? 'data_tables'` is true, `22742` still has its 130 authors, `14508` its 35 data tables.

### P3 — build `nsr_exfor`

```
P3 done: 21423 nsr rows -> 23515 pairs, 21423 distinct nsr keys, 20825 distinct exfor ids, 0 blank tokens
```

- **pairs:** 23,515
- **distinct NSR keys:** 21,423 — i.e. **every** NSR row that has `exfor_keys` produced at least one link, no row dropped
- **distinct EXFOR ids:** 20,825

**Orphans, NSR → EXFOR: zero.** Every one of the 20,825 accession numbers NSR points at exists in `exfor_entries`. There are no examples to note — the `LEFT JOIN … WHERE e.exfor_id IS NULL` returns 0 rows. That is the single most reassuring number in this lane: it means NSR's `exfor_keys` and the IAEA library agree completely, and it retroactively validates the "load the whole library, not just the linked subset" instruction.

**Orphans, EXFOR → NSR: 6,245** entries (23% of the library) have no NSR link. Expected — EXFOR compiles reports, theses and conference data that NSR either doesn't index or references by a different key.

Token accounting, since 24,276 raw tokens became 23,515 pairs — the 761 difference is **not** loss:
```
 raw_tokens | distinct_pairs
------------+----------------
      24276 |          23515
```
`count(DISTINCT (key_number,k))` is exactly 23,515, so the gap is entirely the same accession repeated inside one row's `exfor_keys` string. The loader's per-row dedupe drops precisely those and nothing else.

### P4 — verification output

```
 entries | links | nsr_with_exfor | orphan_links
---------+-------+----------------+--------------
   27070 | 23515 |          21423 |            0
(1 row)
```

Indexes applied from the block at the foot of `sql/17-exfor-entries.sql`, then `ANALYZE`:
```
 exfor_entries_pkey | idx_nsr_exfor_exfor | idx_nsr_exfor_key
```

Sizes in Neon: `exfor_entries` **385 MB**, `nsr_exfor` **2.3 MB**.

Join smoke test (`1962JA09`, the two-key sample from P1) resolves end to end:
```
 key_number |          nsr_title           | exfor_id | year |          reactions           | num_subentries
------------+------------------------------+----------+------+------------------------------+----------------
 1962JA09   | Direct Observation of Reson… | 11827    | 1962 | ["42-MO-95(N,0),,EN", …]     |              3
 1962JA09   | Direct Observation of Reson… | 13662    | 1962 |                              |              1
```

### Wall time per phase / surprises

| phase | wall |
|---|---|
| P1 clone (~2 GB) + probes | ~6 min |
| P2 entries (27,070 rows, 0.78 GB pushed) | **433 s** |
| P3 links + P4 indexes/verify | ~5 s |
| **full `ingest-exfor.mjs` run, all phases** | **7 min 18 s** |

**Surprise 1 — the library is 2.06 GB, not ~25k small files.** 27,070 entries, median 15 KB, but p99 is 1.0 MB and the largest single entry is **94 MB** (`14508`). Subdirs `232`/`233` alone hold 200 MB. I stress-tested the 94 MB entry through the COPY path on its own before trusting the full run: it loads in 44 s and jsonb normalises it 94 MB → 37 MB.

**Surprise 2 — the naive load was ~20× too slow, and the fix was free.** My first full attempt pushed the pretty-printed file text straight into `raw` over a single serial COPY stream. It managed 725 entries in ~7 minutes and was tracking toward hours. Diagnosis: node sat at 0.6% CPU and every `psql` at ~0.3%, so the client wasn't the constraint — it was bytes-on-the-wire plus Neon-side jsonb ingest. Two changes, no semantic difference:
1. `JSON.stringify(parsed)` instead of the raw file text — the files are pretty-printed at 2-space indent and **jsonb discards insignificant whitespace anyway, so the stored value is byte-identical**, but it cut the payload 2.06 GB → 0.78 GB (2.6×).
2. `CONCURRENCY = 3` overlapping COPY streams, with backpressure so at most 3 chunks of payload are ever resident.

Same 725 entries after the change: **19 s instead of ~7 min.** I restarted the load at ~3% done to pick this up; the tables are DROP+CREATE so the restart was clean. If this ever needs re-running, raising `CONCURRENCY` is the next lever — Neon, not this machine, is still the bottleneck.

**Flag for the lead — `raw` is 90% numeric data tables.** The brief specified `raw` = the full entry JSON and that is what shipped, but the measurement is stark: of 2.06 GB of source, only **195 MB (9.5%)** is everything-except-`data_tables`. `data_tables` is the numeric measurement grid — cross-sections, energies, uncertainties — which no text search or embedding pass over this corpus will ever read. Dropping it from `raw` (keeping it in the IAEA clone, which is reproducible in one command) would take `exfor_entries` from **385 MB to roughly 40 MB** — a ~10× cut in Neon storage for this table. I did **not** do it: it's a schema decision and it's yours. One-line change in `ingest-exfor.mjs` if you want it (the `noTables` object is already computed there for exactly this measurement).

**Minor:** `sql/04-exfor-entries.sql` (Supabase-era, `text[]` columns, RLS policies) is now dead — superseded, and `sql/17` says so in its header. `scripts/load-exfor.py` is likewise dead; note it carries a hardcoded Supabase anon key inline (publishable by design, so not an incident, but it's dead weight worth deleting alongside).

**Nothing committed, nothing pushed** — per the brief. Working tree adds `scripts/ingest-exfor.mjs` and `sql/17-exfor-entries.sql`; `data/exfor_json/` (2 GB) is covered by the existing `data/` gitignore rule. `nsr` was read-only throughout.
