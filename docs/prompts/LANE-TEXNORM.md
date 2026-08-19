# LANE-TEXNORM — TeX normalizer + DOI hygiene

**Free window. Est. 45–60 min. You execute; you do NOT commit or push — the lead handles git.**

## Mission
Three pieces of corpus hygiene that unblock the DOI-recovery lane and the embedding run:
1. A **TeX-stripping normalizer** (`$^{232}$Th` → `232Th`, `$\gamma$` → `gamma`), validated against ground truth we already hold.
2. **Fix the 43 malformed DOIs** in `nsr` (found by LANE-S2 — doubled dots, backslashes, `doi:`/URL prefixes, pasted ` get` suffixes, leading `1` typos).
3. **Classify the 589 duplicate-DOI rows** (found by LANE-OPENALEX) — report, no deletions.

## Context
- Repo `/Users/brendanstanton/Code/nsr`, Neon via `DATABASE_URL_UNPOOLED` (unpooled). U+0000 only as an escape sequence.
- Ground truth for validation: `data/openalex/page-*.json` (3,364 cached OpenAlex pages) — each work has `title`/`display_name` AND its DOI, and 167,949 of our rows carry a matched `openalex_id`. So for any NSR row with a TeX title and a known DOI, you can measure whether normalized-NSR-title matches normalized-OpenAlex-title — precision/recall at zero API cost.
- LANE-S2's report (in `docs/prompts/LANE-S2.md`) lists example malformed DOIs.

## Hard rules
1. DB writes allowed: **`nsr.doi` UPDATEs on exactly the malformed rows** (each individually justified in REPORT with before→after), nothing else. Duplicate-DOI work is read-only.
2. The normalizer is a **library**: `scripts/lib/textnorm.mjs` exporting `stripTex(s)` and `normTitle(s)` (stripTex + lowercase + collapse whitespace + strip punctuation), with a test file `scripts/lib/textnorm.test.mjs` (plain `node:assert`, runnable via `node scripts/lib/textnorm.test.mjs`) covering: superscript/subscript nuclides, Greek letters, `\mathrm`/`\mathit`, math-mode reactions like `$^{232}$Th(n,F)`, `{+232}`-style exchange notation, mixed TeX+plain, and pathological unclosed `$`.
3. Blocked >10 min → REPORT, move on.

## Phases
**P1 — normalizer + tests.** Build from the actual corpus: sample 500 TeX-bearing titles (`title LIKE '%$%'`) across decades, eyeball the constructs, cover them.

**P2 — offline validation.** From the OpenAlex cache: pair each cached work's (title, DOI) with our (title, key_number) via the DOI. Take the ~pairs where our title contains TeX. Score: `normTitle(nsr) == normTitle(openalex)` exact-match rate, and ≥0.9 token-Jaccard rate. **Target: >85% Jaccard-match on TeX-bearing pairs.** Report the failure examples — they define the next iteration. Paste the score table into REPORT.

**P3 — DOI fixes.** Find all malformed DOIs (start from S2's list; also scan: `doi !~ '^10\.\d{4,9}/'`). For each: proposed fix (strip `doi:`/`https://dx.doi.org/` prefixes, `\` → `/`, collapse `..` → `.`, drop trailing ` get`/whitespace, drop leading junk before `10.`). Verify each fixed DOI resolves via the Handle API (`https://doi.org/api/handles/{doi}`, ~1 req/s — never a publisher page). Apply only the ones that verify; REPORT the full before→after table including unfixable leftovers.

**P4 — duplicate-DOI classification (read-only).** CONTEXT UPDATE: the stub-DOI fan-out was already discovered live (206 shared DOIs / 789 rows; journal-level stubs like `10.15407/jnpae` on 243 rows) and the lead has wiped the fanned enrichment from all of them (`s2_lookup_status='ambiguous_doi'`). Your job is the *taxonomy*: for every DOI shared by >1 `key_number`, classify — journal-level stub vs erratum pair vs preprint-vs-published vs true accidental duplicate vs NSR data-entry dupe. Table of classes, counts, 3 examples each, and a per-class recommendation (incl. whether stub DOIs should be moved out of `doi` into a `journal_doi` column). NO deletions, NO writes.

## REPORT (fill in as you go)
- Status:
- P2 validation scores + worst failures:
- P3 DOI before→after table (applied / unfixable):
- P4 duplicate classes + recommendation:
- Wall time / surprises:
