# LANE-MINE — build the supervision-signal harvesters, then run them the moment the corpora land

**HARD CAPS: Phase 1 (build + verify) starts now; Phase 2 (full harvest runs) is gated on the loader finishing — check row counts read-only before firing. DB fence: endpoint host must be `ep-orange-water-aut2eymf` before any connection; never touch /Code/nsr or its database. You own `scripts/mine/` (create it) and this file — do NOT edit `api/`, `sql/`, `src/`, the rig directories, or top-level loader scripts (build and rig-port lanes own those). Harvest outputs land in `data/mine/` (gitignored) as jsonl — no DB writes this lane; DDL for mining tables goes in your REPORT as a proposal only. External APIs: keys from `.env.local` only; verify each source's rate policy empirically with a small probe before committing to a full run, stay polite, and put measured throughput in the REPORT. Any step that spends money (Bedrock generation) gets an estimate in the REPORT and Brendan's go BEFORE the full run. No HF pushes. Commits allowed (your files + this doc), gated by `npx tsc -b && npm run build`; do NOT push. Edit this file in place; the REPORT is the deliverable.**

## Mission

CSHL's fine-tune needs what NSR had for free: gold supervision. NSR trained on 206k expert
keyword abstracts; this corpus has none — but it has something arguably better, spread
across four external signals plus one internal one. Build the harvesters tonight, verify
each on the sample DOIs already in `docs/prompts/LANE-RXIV-MAP.md` (REPORT evidence), and
the moment the loader finishes, run them — so that by morning we hold every dataset the
training lane needs. Target: harvest complete in hours, not days. If a source's fastest
path can't beat the target, say so with numbers and propose the cut.

We are not building "a signal." We are building the supervision suite for a model program
whose stated aim is to set the standard others benchmark against. That means: citation
graph for doc-doc structure, MeSH for hierarchical gold labels, query-shaped pairs for the
actual retrieval task, and clean eval holdouts for all three — assembled with the same
discipline as NSR's (split by paper hash, frozen before training, provenance recorded).

## Ground

- Corpus: ~345,854 bioRxiv + ~87,564 medRxiv papers (~433k), business key = bare DOI
  suffix with (server, doi) unique guard — schema per LANE-RXIV-MAP.md Task-6 REPORT.
  ~49% (~215k) have a `published` journal DOI; those are the MeSH-reachable half.
- Signals, ranked (from the map lane + review):
  1. **Citation graph** (~100% reachable) — SPECTER/SciNCL recipe: cited = positive,
     citation-of-citation-not-cited = hard negative. Trains the encoder's doc-doc space.
  2. **MeSH via published DOI** (~215k) — NLM-indexer-assigned, hierarchical, with
     qualifiers + major-topic flags. Classifier gold AND pseudo-query source.
  3. **Query-shaped pairs** — the gap in everything above: retrieval is query→doc, not
     doc-doc. Sources: MeSH-terms-as-query → paper (mirrors NSR's keyword→abstract
     recipe), and LLM-synthetic queries over abstracts (100% coverage) via Bedrock.
  4. **Category labels** (100%, 76 classes post-normalization) — classifier set,
     day-one, no external calls; also same-category = harder negatives for mining.
  5. **Version pairs / preprint↔published pairs** — near-duplicate positives; WEAK for
     contrastive training (model learns lexical overlap). Harvest cheaply for eval
     robustness and the peer-review-delta feature; do not put them in the triplet set.
- Candidate sources per signal — pick by MEASURED throughput, not reputation:
  - Citations: **OpenAlex** `referenced_works` (every work carries it; batch via
    `filter=doi:a|b|c…` ~50/call, polite pool with `OPENALEX_MAILTO` — likely the fastest
    full-corpus path); **S2 Graph API batch** (`POST /graph/v1/paper/batch`, 500 IDs/call,
    `SEMANTIC_SCHOLAR_API_KEY` in env — verify which reference fields the batch endpoint
    actually returns and the key's real rate tier); Europe PMC per-record as fallback.
  - MeSH: **NCBI E-utilities** — DOI→PMID via idconv (~200/call), then `efetch`
    db=pubmed (~200 PMIDs/call, XML carries full MeSH with qualifiers; `api_key` = 10
    req/s) — likely minutes-scale for 215k; Europe PMC REST as fallback/cross-check.
  - Synthetic queries: Bedrock Haiku over title+abstract, 3–5 queries/paper on a chosen
    subsample — validate the prompt on 20 papers, then COST the full run and wait for go.
- The rig-port lane (`docs/prompts/LANE-RIG-PORT.md`) consumes your output. Coordinate
  through the two REPORT files: publish your output schemas there the moment they're
  fixed; don't edit their scripts.

## Tasks

1. **Citation harvester.** Build, then race a 1k-DOI probe on OpenAlex-batch vs S2-batch:
   measured req/s, refs-per-paper yield, coverage (papers with ≥1 resolved reference).
   Pick the winner, write the choice + numbers in the REPORT, then Phase-2 the full
   corpus. Output `data/mine/citations.jsonl`: `{key, server, doi, refs: [ids…], source}`.
   Resolve referenced works back to OUR corpus keys where they exist (in-corpus edges are
   what triplet mining uses); keep out-of-corpus refs too (future graph enrichment).
2. **MeSH harvester.** DOI→PMID→MeSH pipeline, batched. Probe 200 published DOIs first:
   PMID-resolution rate, MeSH yield, throughput. Output `data/mine/mesh.jsonl`:
   `{key, pmid, mesh: [{descriptor, qualifiers, major}], author_keywords}`.
3. **Synthetic-query generator.** Prompt + script; validate on 20 papers (queries must
   look like things a researcher types, not paraphrased titles — include the 20 outputs
   in evidence). Recommend the subsample size and give the full-run Bedrock cost. GATED:
   full run only after Brendan's go.
4. **Triplet + dataset assembly (Phase 2).** From 1–3 plus the loaded DB:
   - `cshl-triplets`: SPECTER-style (query=paper, pos=cited-in-corpus, hard-neg=
     citation-of-citation + same-category-not-cited), SciNCL-style neighborhood variant
     NOTED as a follow-up that needs embeddings (flag the dependency — embeddings land
     via the rig lane; design the sampler so it can re-run in neighborhood mode later).
   - `cshl-mesh-classify`: paper → MeSH descriptors (and the category set as
     `cshl-category-classify`, free, assembled directly from the DB).
   - `cshl-query-pairs`: MeSH-as-query + synthetic queries → paper.
   - Eval holdouts for each, split by paper hash, sized per the rig lane's `cshl-eval-v1`
     draft — frozen files written to `data/mine/eval/`, checksums in the REPORT.
5. **Sizing + handoff.** Final counts (papers covered, edges, triplets, labels, pairs),
   bytes, wall-clock per harvester, and the exact file paths + schemas the train rig
   should consume. Propose (DDL text only) any mining tables worth materializing in the
   DB later, in NSR's `nsr_train_mining` tradition.

## Report format (edit this file)

Per task: findings, measured throughput table (source, req/s, calls, wall-clock), output
schema, evidence excerpts (≤10 lines). End with the dataset inventory, the two gates that
need Brendan (synthetic-query spend; anything slower than hours), and a Next-lane sketch
(training handoff).

## REPORT

### Log (timestamped, newest last)

- **2026-08-19 01:25Z — ack.** Channel read; DIRECTIVES re-read after every filing.
- **2026-08-19 06:4xZ — seam closed properly, and the `cshl` rename taken while it is free.**
  The cap number agreed at 4000 but the *shape* did not: I capped `left(abstract, 4000)` with the
  title separate, the rig caps the whole concatenation. Same number, different string for the ~1%
  tail. Fixed by **importing** the rig's `scripts/eval/recipe.mjs` rather than copying it, plus a
  seam guard in `--verify`. All dataset identifiers renamed `rxiv-*` → `cshl-*` per Brendan; old
  files deleted rather than left beside the new ones. ALL INVARIANTS HOLD. See §4f.
- **2026-08-19 03:25Z — independent verifier added; ALL INVARIANTS HOLD on the medRxiv slice.**
  `assemble.mjs --verify` re-derives every leak claim from the FILES rather than the generator's
  own counters (§4e). Waiting on the bioRxiv gate — loader walk at 84.4%, DB still 197,539.
- **2026-08-19 03:05Z — medRxiv slice COMPLETE end to end; both Brendan rulings actioned.**
  Citations + MeSH harvested, EXTRACT family built and generated (197,534 papers, no spend), full
  assembly run. **Found and fixed a real design error in my own split rule — it was discarding
  99.3% of the triplets (§4b).** Bedrock stays unrun; doc2query rider priced below for the rig
  lane. bioRxiv still held on the BUILD addendum.
- **2026-08-19 02:35Z — PHASE 2 FIRED ON THE medRxiv SLICE** per the lead's gate change. Citations
  **complete** (86,138 works in 59 s — see §1b, the projection was 25× pessimistic); MeSH running.
  bioRxiv still held pending the build lane's BUILD addendum. Synth and the eval freeze remain
  untouched per directive (d) — both need Brendan.
- **2026-08-19 02:05Z — PHASE 1 COMPLETE + all five lead directives worked.** MeSH vocabulary
  harvested and parsed (§2b), E-utilities moved to EPost/history-server, `NCBI_API_KEY` picked
  up and its effect measured, entry-term synonyms and MeSH tree-sibling negatives wired into the
  query-pair generator. Gate re-run green. **Phase 2 still HELD** — see the loader watch below.
- **2026-08-19 01:45Z — PHASE 1 (first pass).** All four harvesters built under `scripts/mine/`,
  every source raced or probed empirically, all three probe budgets spent and reported below.
  Gate green: `npx tsc -b` exit 0, `npm run build` ✓ built in 5.58s. **Phase 2 is HELD** —
  loader read `197,539 / ~433,000` preprints at this write (biorxiv walk 68% done), so the
  full harvest runs have not fired. No DB writes (every psql session opens with
  `default_transaction_read_only = on`), no HF pushes, no Bedrock spend beyond the 20-paper
  validation ($0.043).

---

### Status

| task | built | verified on | Phase-2 state |
|---|---|---|---|
| 1 citation harvester | `scripts/mine/citations.mjs` | 1,000-DOI 3-way race + a real 110-work shard walked, resolved, and resumed | **ready to fire** |
| 2 MeSH harvester | `scripts/mine/mesh.mjs` | 200 published DOIs, 4 paths raced, cross-validated against an independent source | **ready to fire** |
| 3 synthetic queries | `scripts/mine/synth-queries.mjs` | 20 papers through Bedrock Haiku 4.5, 80 queries scored for title echo | **BLOCKED on Brendan** (spend) |
| 4 assembly | `scripts/mine/assemble.mjs` | text sidecar built (197k rows), category set + eval freeze run end to end | **ready to fire** |
| 5 sizing + handoff | this REPORT | — | schemas published below for the rig lane |

---

### 1 Citation harvester — OpenAlex wins on every axis; the source walk beats DOI batching 4×

**Race, 1,000 corpus DOIs, identical sample (deterministic `md5(key_number)` order so reruns compare like for like):**

| arm | calls | wall-clock | req/s | papers/s | resolved | ≥1 ref | refs/paper |
|---|---|---|---|---|---|---|---|
| **openalex-batch/50** (`filter=doi:a\|b\|…`) | 20 | 3.8 s | 5.29 | **264** | **99.2%** | **97.4%** | 37.3 |
| s2-batch/500 (`POST /graph/v1/paper/batch`) | 2 | 28.7 s | 0.07 | 35 | 76.5% | 43.2% | 17.8 |
| **openalex-walk/200** (source cursor) | 8 | 5.3 s | 1.50 | **300** | 100% | 99.8% | 54.7 |

Head-to-head on the 759 DOIs both resolved: **OpenAlex 36.3 refs/paper vs S2 17.9** — S2 returns
roughly half the references, and 233 papers OpenAlex found were missing from S2 entirely against
6 the other way. **Verdict: OpenAlex. S2 is not a close second and is not worth a fallback path.**

**The finding that changed the plan: walk the sources, don't batch the DOIs.** OpenAlex now bills
1 credit per filter call against a 10,000/day pool (measured from `x-ratelimit-limit` with our
key; the anonymous polite pool is **1,000/day**, so the key is load-bearing) — and that pool is
shared with the 44b project. Batching 433k DOIs at 50/call costs ~8,668 credits, most of a day.
Cursor-walking the two rxiv **sources** instead returns 200 works/call for ~2,140 credits, and —
the real prize — every rxiv work in the graph comes back with its `id` **and** its `doi`, which
*is* the OpenAlex-work-id → our-business-key bridge that reference resolution needs. DOI batching
survives only as `--gapfill` for whatever the source walk misses.

```
sources verified:  S4306402567  bioRxiv (Cold Spring Harbor Laboratory)  340,968 works
                   S3005729997  medRxiv                                   86,176 works   (Σ 427,144 ≈ our 433k)
credit headers:    with key  x-ratelimit-limit: 10000   without key  x-ratelimit-limit: 1000
```

The walk is sharded by `publication_year` (22 shards, 4 in flight, ≤8 req/s aggregate) rather than
run as one 1,700-page cursor: same credit cost, resumable per shard, and not a single point of
failure. **Verified on a real shard**, not just in theory:

```
walk: 1 shards (1 outstanding), 4 in flight, ≤8 req/s aggregate
biorxiv:2013: complete (110 works)      → state {"biorxiv:2013":{"cursor":null,"works":110,"done":true}}
rerun:  walk: 1 shards (0 outstanding) · 0 works · 0 calls    ← resume skips finished shards
resolve: corpus map 197,539 DOIs → bridge 109 entries → 109 papers, 5,445 reference edges
```

**Projection for Phase 2:** 427k works ÷ 300 works/s ≈ **24 min**, ~2,140 calls, ~2,140 credits
(leaving ~7,800 for 44b), ~250 MB raw on disk. Comfortably inside "hours, not days".

**MEASURED, medRxiv slice, Phase 2 (2026-08-19 02:2xZ):**
```
walk: 8 shards (8 outstanding), 4 in flight, ≤8 req/s aggregate
medrxiv:2025: complete (13902 works)
walk: 86,138 works · 435 calls · 8/8 shards complete · 50.2 MB · 58.7 s     → 1,545 works/s
openalex credits: 9,610 of 10,000 remaining after the slice (390 spent)
```
**The 24-minute projection was 25× pessimistic.** It was extrapolated from the serial single-cursor
probe at 300 works/s; the sharded walk runs 4 cursors concurrently and sustains **1,545 works/s**.
Revised whole-corpus estimate: **~5 minutes, ~2,150 credits**. bioRxiv (341k works, 14 shards) is
~4 minutes on this measurement.

**Output schema — `data/mine/citations.jsonl`** (one line per paper):
```json
{"key":"001107","server":"biorxiv","doi":"10.1101/001107","openalex_id":"W2953212639",
 "refs":["W30786801","W1255676896", "…"],   "refs_in":["2019.12.17.879809", "…"],
 "n_refs":50,"n_refs_in":3,"source":"openalex"}
```
`refs` is every reference (out-of-corpus kept for future graph enrichment, OpenAlex `W` ids with
the URL prefix stripped); `refs_in` is the subset resolved back to **our** `key_number` — that is
what triplet mining consumes.

### 2 MeSH harvester — NCBI, two-step, and Europe PMC independently confirms it

**Probe, 200 published DOIs:**

| path | calls | wall-clock | req/s | DOIs/s | result |
|---|---|---|---|---|---|
| ncbi/idconv (200 DOIs/call) | 1 | 0.3 s | 3.39 | 678 | 82.5% resolved to a PMID |
| ncbi/esearch `[AID]` (100/call) | 2 | 0.9 s | 2.26 | 226 | **94.5%** resolved |
| **ncbi/efetch pubmed (200 PMIDs/call)** | 1 | 1.7 s | 0.58 | **109 rec/s** | 190 recs · **75.3% carry MeSH** · 7.8 descriptors/rec · 3.6 author keywords/rec · 5.6 MB |
| europepmc/search core (50 DOIs/call) | 4 | 4.4 s | 0.92 | 44 rec/s | 190 recs · 75.3% · 7.8/rec · 3.6/rec · 2.0 MB |

**Cross-check against an independent source: 143 DOIs indexed by both, 143 identical descriptor
sets — 100.0% agreement, zero one-sided.** That validates the harvest *and* the hand-written
PubMed XML scanner in one measurement.

**Verdict: NCBI two-step.** 2.5× faster per record, and — decisively — efetch returns descriptor
**UI codes** (`D000328`, qualifier `Q000706`) which Europe PMC does not. The D-numbers are what
make these labels *hierarchical* (walkable up the MeSH tree); names alone would flatten the signal
to exactly what NSR had. Europe PMC stays wired in as the cross-check arm, not the harvest path.

Neither DOI→PMID path is sufficient alone — idconv only knows PMC-deposited articles (82.5%),
esearch sees all of PubMed (94.5%) — so the run does idconv first and sends only its misses to
esearch, merging the PMID sets.

**On the EPost amendment (lead directive (b), "do NOT re-architect for EPost").** Recording this
plainly: the EPost path was already built, verified, and measured before that amendment landed, and
it does **not** touch the thing the amendment praises. The idconv→esearch merge — phase A, the
DOI→PMID resolution — is **unchanged and still the design**. EPost only changes how the resolved
PMID list is fetched *back* in phase B, keeps a URL-batch fallback that fires automatically if an
EPost fails, and produces byte-identical records. It is strictly fewer calls for the same result,
so I have kept it rather than reverting verified-faster code — but the choice is now a flag, not a
rewrite: **`--no-epost` forces the URL-batched path**, and the lead can pick either without a code
change. If the amendment was meant as a hard instruction rather than a caution against churn, say
so and I will make `--no-epost` the default.

**Rebuilt on EPost + the history server (lead directive, NBK25497).** The run is now two phases:
**A** resolves every published DOI to a PMID and caches the map to `data/mine/raw/pmid-map.jsonl`;
**B** EPosts the whole PMID list in 5,000-id groups and efetches it back in 500-record pages
against `WebEnv`/`query_key`. Splitting them means a crash in B costs zero re-resolution, and it
collapses the call count from ~4,300 URL-batched requests to **~2,090**. A URL-batch fallback
still fires if an EPost fails.

**Did the API key matter? Yes, measurably — about 3×.** Keyless the pacer sits at 2.5 req/s under
NCBI's 3 req/s ceiling; with `NCBI_API_KEY` it runs at 8 under the 10 req/s tier. Phase A is
purely call-bound, so it scales ~1:1 with the pace: ~1,615 calls is **~11 min keyless vs ~3.5 min
keyed**. Phase B is bandwidth-bound, not call-bound, so the key does not help there. Worth having;
it was not worth blocking on.

**Verified end to end on 400 real published DOIs with the key live:**
```
NCBI api_key: present → 10 req/s tier · pacing at 8 req/s
phase A done: 385 PMIDs from 400 published DOIs · 4 calls          ← 96.3% resolution
phase B: EPost 385 PMIDs, efetch back in pages of 500
mesh.jsonl: 384 records · 326 with ≥1 descriptor (84.9%) · 11.0 MB fetched · 511 KB written
total wall-clock: 5.0 s
```

**MEASURED, medRxiv slice, Phase 2:**
```
phase A: 39,052 published DOIs → 37,171 PMIDs (95.2% resolution) · 393 calls · 52 s
phase B: EPost 37,149 → efetch in 500-record pages, 6 lanes
mesh.jsonl: 30,175 records · 23,486 with ≥1 descriptor (77.8%) · 997 MB fetched · 44.6 MB written · 120 s
```
Two corrections I made mid-run, both worth recording because both were my errors:
1. **Phase B was serial.** One 15 MB page at a time left the pace budget unspent and the link
   idle at 3.3 MB/s. Pages within an EPost group are independent (`retstart`/`retmax` against one
   `WebEnv`), so they now run through a bounded pool — **12 MB/s, 231 papers/s**, ~4× faster.
2. **Resume re-downloaded what it already had.** A resumed run re-fetched every already-written
   record and discarded it as unmatched — correct output, twice the bandwidth. It now reads the
   PMIDs already in `mesh.jsonl` and excludes them before the EPost. (The 6,974 "matched no corpus
   DOI" in the run above is exactly that bug, caught in the act.)
Also added a second join key: a PubMed record whose own DOI string differs from the one bioRxiv
recorded still lands on the right paper via `pmid → doi` inverted from phase A.

**Whole-corpus projection:** ~215k published DOIs ≈ **12 min**, ~6 GB fetched, ~250 MB written.

**Output schema — `data/mine/mesh.jsonl`:**
```json
{"key":"2024.04.07.24305438","server":"medrxiv","published_doi":"10.1111/febs.15578",
 "pmid":"33006196","pmcid":"PMC8049052","journal":"The FEBS journal",
 "mesh":[{"ui":"D017057","descriptor":"Medically Uninsured","major":true,
          "qualifiers":[{"ui":"Q000706","name":"statistics & numerical data","major":true}]}],
 "author_keywords":["cervical cancer screening","low-income women"],
 "publication_types":["Journal Article"],"source":"ncbi/efetch"}
```

### 2b MeSH vocabulary — the controlled vocabulary itself (lead directive, from Brendan)

Distinct from the per-paper assignments above: this is the NLM MeSH tree, downloaded once as bulk
XML (no rate policy, no key, no pagination) and stream-parsed — the 313 MB file is never held in
memory.

```
desc2026.xml  313.0 MB   →  data/mine/mesh_dict.jsonl        31,110 descriptors · 43.2 MB
qual2026.xml  291 KB     →  data/mine/mesh_qualifiers.jsonl       76 qualifiers · 27 KB
31,108 of 31,110 descriptors carry tree numbers · 235,902 entry terms (7.6/descriptor) · 115 tree roots · max depth 13
fetch 107 s · parse 2.5 s
```

**Schema — `data/mine/mesh_dict.jsonl`:**
```json
{"ui":"D055088","name":"Early Detection of Cancer","tree_numbers":["E01.390.500"],
 "entry_terms":["Cancer Early Detection","Early Diagnosis of Cancer","Cancer Screening", "…"],
 "scope_note":"Methods to identify and characterize cancer in the early stages…",
 "allowable_qualifiers":[{"ui":"Q000706","name":"statistics & numerical data"}, "…"],
 "parents":["D042241"],"depth":3}
```
`parents` and `depth` are derived in a second pass from a tree-number→UI index — MeSH ships the
tree numbers but not the edges, and a descriptor can sit at several places in the tree, so
`parents` is a set. `mesh_qualifiers.jsonl` carries the same shape plus `abbreviation` (the `IM`,
`EP`, `ST` codes that come back in efetch and Europe PMC payloads).

**Both payoffs are already wired into the assembler, not just noted:**

1. **Entry-term synonyms in the MeSH query family.** A fixed descriptor string per concept would
   teach the model exactly one surface form. 40% of query terms are now drawn from entry terms
   (measured 37–38% — the gap is descriptors with no usable synonym). One refinement worth
   recording: MeSH entry terms include **index-inverted forms** — `"Cell, Nerve"`,
   `"Factors, Transcription"`, `"ATPase, Actin Activated"` — that no human types into a search
   box. Training on those teaches a surface form that never occurs in a real query, so the loader
   filters any entry term containing a comma. Before and after, same two papers:
   ```
   before: Cell, Nerve; Non-Polyadenylated RNA; DNA Dependent RNA Polymerase II; Factors, Transcription
   after:  Nerve Cells; Non-Polyadenylated RNA; DNA Dependent RNA Polymerase II; Transcription Factor
   before: Muscle Contractions; ATPase, Actin Activated
   after:  Muscular Contraction; Myosin
   ```
2. **Tree-sibling hard negatives.** "Same MeSH parent, different leaf, and shares none of the
   positive's descriptors" is a principled hard negative; same-category is a blunt instrument next
   to it. `mesh-tree-sibling` is now the first negative source tried for every MeSH/author-keyword
   query, with same-category filling the remainder. On the 384-paper verification slice the
   sibling pool is thin (549 of 4,112 negatives, 13%) purely because the descriptor→paper index
   only had 326 papers in it; at ~175k labelled papers it becomes the dominant source.

**Proposed DDL (text only, NOT applied) — the `subject_dict` analog:**
```sql
CREATE TABLE mesh_dict (
  ui           text PRIMARY KEY,          -- D-number
  name         text NOT NULL,
  tree_numbers text[],                    -- a descriptor can sit at several places
  parents      text[],                    -- derived from tree_numbers, not shipped by NLM
  depth        int,
  entry_terms  text[],                    -- synonyms → typeahead, facet display, query variation
  scope_note   text,
  allowable_qualifiers text[]
);
CREATE INDEX idx_mesh_dict_trgm    ON mesh_dict USING gin (name gin_trgm_ops);
CREATE INDEX idx_mesh_dict_entry   ON mesh_dict USING gin (entry_terms);
CREATE INDEX idx_mesh_dict_parents ON mesh_dict USING gin (parents);

CREATE TABLE mesh_qualifiers (
  ui text PRIMARY KEY, name text NOT NULL, abbreviation text,
  tree_numbers text[], entry_terms text[], scope_note text
);
```
This is the table that would let `/api/dict?type=mesh` behave like the old nuclide combobox —
typeahead over 31k canonical names **plus** 236k synonyms, which is a materially better facet than
the 76-value category list, and it restores the controlled-vocabulary slot the corpus lost when
NSR's expert keywords died.

### 3 Synthetic queries — prompt validated, GATED on spend

Model `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Bedrock inference profile, ACTIVE in
us-east-1; same id the app already ships in `src/lib/models.ts`). Structured output is forced via
a Converse `toolConfig` with `toolChoice`, so there is no JSON parsing to fail.

**The failure mode the prompt is built against:** ask an LLM for "queries about this paper" and it
writes paraphrased titles; a model trained on paraphrased titles learns title matching, not
retrieval. So the prompt demands four query **families** of different shape and length, bans
reusing the title's distinctive noun phrase, bans "this study"/"the authors", and requires the
`broad` family to be a query the paper is *one good answer among many* for.

**Measured on 20 papers — 20/20 produced all 4 queries, 37.4 s serial:**

| family | mean title overlap |
|---|---|
| keyword | 52.3% |
| question | 31.0% |
| method | 27.3% |
| broad | 23.3% |

Mean across all 80 queries **33.5%**; only **2/80 above 80%**, and inspection says both are
honest — `"RNU4-2 spliceosomal snRNA neurodevelopmental disorders"` is genuinely what a specialist
types for that paper. The `keyword` family is structurally the leakiest (it is *supposed* to be
terminology); `method` and `broad` are doing the real work.

**Evidence — 4 of the 20, verbatim** (all 20 in `data/mine/raw/synth-validate.json`):
```
398677 [neuroscience]  Local Homogeneity of Tonotopic Organization in the Primary Auditory Cortex of Marmosets
  keyword   tonotopic map primary auditory cortex primate
  question  How are frequency tuning properties organized at the cellular level in marmoset auditory cortex?
  method    two-photon calcium imaging neuronal frequency tuning auditory cortex
  broad     cortical organization and functional architecture in sensory systems
291336 [immunology]   NK cells inhibit Plasmodium falciparum growth in red blood cells via ADCC
  keyword   natural killer cells malaria antibody dependent cytotoxicity
  method    NK cell-mediated ADCC assay using immune sera and infected erythrocytes
  broad     antibody-dependent cellular cytotoxicity in parasitic infections
```

**Cost — from measured tokens, not estimates:** 1,427 input + 141 output tokens per paper →
**$2.13 per 1,000 papers** at Bedrock on-demand Haiku 4.5 ($1.00/$5.00 per 1M).

| subsample | cost | wall-clock @12 lanes | what it buys |
|---|---|---|---|
| 25,000 | **$53** | ~40 min | 100k queries — enough to prove the family helps |
| **50,000** | **$107** | ~1.3 h | 200k queries — **my recommendation** |
| 100,000 | $213 | ~2.6 h | 400k queries |
| 433,000 (full corpus) | $923 | ~11 h | 1.73M queries |

**Recommendation: 50,000 papers / $107.** NSR's winning encoder trained on a ~39.6k triplet
subsample; 200k query→doc pairs is already 5× that, and the marginal value of pairs 200k→1.7M is
far below the marginal value of spending the same $800 on a second training run. The sampler is
deterministic (`ORDER BY md5(key_number)`), so a later top-up is a strict superset — nothing is
wasted by starting at 50k. `--run` **refuses to execute** without `--i-have-brendans-go`.

### 4 Assembly — built, and the category family is already through it end to end

One record shape for all four families, **deliberately byte-compatible with
`scripts/train/build-nsr-triplets.mjs`** so the 44b trainer and the rig lane's harness run
unchanged:

```json
{"query": <string | {"slug":…}>,
 "positive":  {"slug":"2020.02.11.943159"},
 "negatives":[{"slug":"…","source":"citation-of-citation"}, {"slug":"…","source":"same-category-uncited"}],
 "meta":{"family":"CITE|MESH|AUTHORKW|SYNTH|CAT","category":"biochemistry","server":"biorxiv"}}
```

**Text lives in exactly one place.** Inlining title+abstract into every training record would
duplicate a popular paper's abstract across every triplet it appears in — gigabytes of the same
bytes. Training files carry **slugs**; text joins from a single sidecar
`data/mine/corpus-text.jsonl` (`{key, server, year, category, title, abstract, published_doi}`,
abstract capped at 2,000 chars = the embed rig's exact input recipe, so nothing the model will
ever see is lost). **The frozen eval files are the one exception** — they inline text so
`cshl-eval-v1` is self-contained and publishable.

**Split discipline (NSR's, verbatim).** `h32 = parseInt(md5(seed + key_number).slice(0,8),16)/0xffffffff`
— byte-identical to the function in `scripts/eval/build-nsr-eval.mjs`, so the rig lane can
recompute any split without asking us. Holdout seed `holdout:` at **0.25**; split seed
`cshl-training-pairs-2026-08-19` at train <0.8 / val <0.9 / test ≤1.0. Two hard rules enforced in
code: a held-out paper **never** appears in a training file in any role, and a record whose papers
straddle two splits is **dropped, not assigned**. Negative sampling uses a key-seeded xorshift —
there is no `Math.random` anywhere in the assembler, because a benchmark you cannot reproduce is a
number you cannot defend.

**Triplet recipe (SPECTER):** anchor = paper, positive = a paper it cites *in corpus*, hard
negatives = half `citation-of-citation` (cited by the positive, not by the anchor — topically
adjacent, one hop too far) and half `same-category-uncited` (the only negative available for the
sparsely-cited tail). **SciNCL neighborhood mode is a flagged follow-up, not a gap**: it needs
embeddings, which land via the rig lane's embed pass into `preprint_embeddings`. The sampler is
written so a neighborhood arm drops in as a third negative source without touching the split logic.

### 4b The split rule was wrong, the measurement caught it, here is the correction

Worth stating plainly because it would have quietly wrecked the triplet set. My first cut required
**every** paper in a record — anchor + positive + 8 negatives — to fall in the same split. On the
medRxiv slice that dropped **34,520 of 34,753 records (99.3%)**, leaving 233. The arithmetic is
obvious in hindsight: `0.8^10 ≈ 10%`, and with the 25% holdout on top, ~0.7% survive. Exactly what
was measured.

And it was protecting nothing:

- **A negative is a distractor, not supervision.** Putting a held-out paper in a training record's
  negative list teaches "not relevant to this query" — nearly always true, and it carries no
  benchmark signal.
- **A held-out positive is just a corpus document.** Every retrieval benchmark indexes the full
  corpus; held-out papers must be embeddable and retrievable or the benchmark is unrunnable.
  Holding a document out of ever being a *positive* handicaps the corpus representation and
  protects nothing.
- **The leak that actually matters** is a held-out anchor's own `(anchor → positive)` edge showing
  up in training. Splitting on the **anchor** makes that structurally impossible — a held-out paper
  is never a training anchor.

So: **split by the anchor, because the anchor is the query.** This is also NSR's rule (it split on
the paper the query was derived from), and it is already how the query-pair families split (on the
paper the MeSH/author-keyword query came from) — so the two lanes and the four families now agree.
`--strict-split` restores the old behaviour if anyone wants to see it.

```
before (all-papers):  records train 233   val 0     test 0     · dropped 34,520 straddling
after  (anchor):      records train 20,673 val 2,574 test 2,666 · dropped 0 · held-out reserved 8,840
ANCHOR-DISJOINTNESS |train∩val|=0 |train∩test|=0 |val∩test|=0 → PASS
```

### 4c EXTRACT — the free query family (Brendan's ruling, lead's correction)

Bedrock generation is rejected, so query-shaped supervision at 100% coverage now comes from
`scripts/mine/extract-queries.mjs`: IDF-weighted RAKE, no model, no API, no spend.

**The design decision that makes it work: candidate phrases come from the ABSTRACT ONLY, never the
title.** That is the guarantee, not a shortcut — a query built from title words *is* a title
paraphrase, which is the exact failure mode that teaches a retrieval model to match titles. RAKE's
within-document degree/frequency finds what a document is *about*; corpus IDF (89,588 terms at
df≥5 over 197,537 abstracts) kills the phrases every biomedical abstract shares.

**Measured: mean title-overlap 17.0% across all 197,534 papers** — against 33.5% for the Bedrock
prompt it replaces. Free, and by this measure less title-echoing.

Three source-text artifacts had to be fixed to get there, all visible in the output before the fix:
literal backslash-`n` sequences in bioRxiv abstracts (two characters, not a newline); section
headers run into the following word (`"Summary statementHeliconius butterflies"` → split on the
lower→upper transition before lowercasing); and `-ly` adverbs plus `-ed` participles at phrase
edges turning queries into sentence fragments. `-ing` is deliberately **not** filtered — in this
domain gerunds are nouns (sequencing, imaging, binding, folding).

```
before: exons located farther apart; directly measure exon connectivity; four drosophila genes dscam1
after:  dscam1 mrp mhc; deconvolute individual isoforms; oxford nanopore min; maximum read lengths
before: apurinic apyrimidinic endonuclease; altering cellular phenotype ascribes; initiate base excision repair
after:  apurinic apyrimidinic endonuclease; 8-oxoguanine dna glycosylase; base excision repair
197,534 papers · 5 skipped (no usable abstract) · 79.3 MB · 28 s
```
**EXTRACT is training-only, by ruling.** `pairs()` drops it for held-out papers rather than routing
it to eval, and `freeze()` re-filters the benchmark to human-origin families — enforced where it is
written *and* where it is read.

### 4d Dry-run, end to end, on the 197,539 rows loaded so far:
```
corpus-text.jsonl        197,539 papers · 357.1 MB · 99 s
citations.jsonl           79,218 papers · 2,885,247 reference edges · 56,612 IN-CORPUS · 55.9 MB
mesh.jsonl                30,175 records · 23,486 with descriptors · 44.6 MB
queries-extract.jsonl    197,534 papers · 79.3 MB
cshl-category-classify   76 classes · train 118,378 · val 14,857 · test 14,764 · heldout 49,493
cshl-triplets            train 20,673 · val 2,574 · test 2,666 · held-out reserved 8,840
cshl-query-pairs         train 146,984 · val 18,424 · test 18,296 · heldout 11,998
  families  MESH 28,985 · AUTHORKW 18,684 · EXTRACT 148,033
  negatives mesh-tree-sibling 16,461 · same-category 1,549,155
top categories: neuroscience 20,861 · epidemiology 12,669 · infectious diseases 12,266 · microbiology 10,629
```
In-corpus citation edges are only 2% of references **because bioRxiv is not loaded yet** — medRxiv
papers overwhelmingly cite journal articles and bioRxiv preprints. This number should jump sharply
once the bioRxiv slice lands; it is the one figure in this report I expect to change materially.

**`cshl-eval-v1` proposal for the rig lane** (they asked for sizes; this is my draft, freeze needs
Brendan). Holdout *reservation* is 25% of the corpus — those papers never train. The frozen
*benchmark* is a deterministic 10,000-row sample per family (NSR froze 9,995), selected by
`md5('eval:' + family + ':' + key_number)`:

| file | query family | rows | source |
|---|---|---|---|
| `cshl-eval-v1.retrieval.jsonl` | MESH · AUTHORKW · SYNTH | 10,000 | query → paper |
| `cshl-eval-v1.docdoc.jsonl` | CITE | 10,000 | paper → cited paper |
| `cshl-eval-v1.mesh-classify.jsonl` | MESHLABEL | 10,000 | paper → descriptors |
| `cshl-eval-v1.category-classify.jsonl` | CAT | 10,000 | paper → 1 of 76 |

**Scoring contract (lead directive (f)) — encoded in the manifest, not left in prose**, so the
harness reads it instead of a human remembering it:
```json
"scoring": {"report_per_family": true,
            "headline_families": ["MESH","AUTHORKW"],
            "flagged_families": ["SYNTH"],
            "note": "SYNTH eval queries share a generator with SYNTH training queries, so their
                     scores flatter the fine-tune. Report them, never fold them into the headline."}
```
`freeze()` also prints the per-family retrieval breakdown on every run. And because the freeze is a
one-way door: it now requires `--i-have-brendans-go` exactly like the spend gate. Without it the
run still executes — you want to see the shape and the counts — but the manifest is stamped
`DRY_RUN: true` and `status: "DRY RUN — not the benchmark"`, so a dry-run artifact can never be
mistaken for the benchmark. **The `manifest.json` on disk right now is a dry run on partial data.**

Checksums for all four land in `data/mine/eval/manifest.json`, which also records the split rule,
the text cap, and per-signal provenance.

### 5 Sizing + handoff

**Files the train rig should consume** (all `data/mine/`, gitignored, jsonl):

| path | what | Phase-2 projected |
|---|---|---|
| `corpus-text.jsonl` | slug → title/abstract join table for everything below | ~433k rows, ~780 MB |
| `citations.jsonl` | citation graph, in- and out-of-corpus | ~427k rows, ~250 MB |
| `mesh.jsonl` | MeSH labels, published half | ~200k rows (~154k with descriptors), ~120 MB |
| `queries-synth.jsonl` | 4 queries/paper | 50k rows (gated), ~30 MB |
| `mesh_dict.jsonl` | MeSH vocabulary: names, synonyms, tree, parents | **built** — 31,110 rows, 43.2 MB |
| `mesh_qualifiers.jsonl` | 76 qualifiers + abbreviations | **built** — 27 KB |
| `cshl-triplets.{train,val,test}.jsonl` | CITE family | sized after the walk |
| `cshl-query-pairs.{train,val,test}.jsonl` | MESH · AUTHORKW · SYNTH | sized after harvest |
| `cshl-mesh-classify.{train,val,test}.jsonl` | hierarchical labels + qualifiers | ~154k |
| `cshl-category-classify.{train,val,test}.jsonl` | 76 classes, **already built** | 148k train+val+test |
| `eval/cshl-eval-v1.*.jsonl` + `manifest.json` | frozen benchmark, text inlined | 4 × 10k |

**Cross-lane consistency catch:** LANE-RIG-PORT's launch item E1 settled the embed input recipe at
a **4000-char** cap (98.9% of documents left whole vs 69.2% at 2000, for +$0.11). My text sidecar
was capped at 2000, which would have meant the text a model trains on and the text it embeds are
different strings. `TEXT_CAP` is now 4000 to match; the Phase-2 rebuild picks it up. If the rig
lane moves that number again, it is one flag on both sides — but it must move on both sides.

**Wall-clock for the whole Phase 2: ~45 min** (citations 24 min ∥ MeSH 10–15 min, then assembly ~10 min)
— excluding synthetic queries, which are gated.

**Proposed mining tables (DDL text only — NOT applied, not written to `sql/`).** In NSR's
`nsr_train_mining` tradition, worth materializing once the jsonl is proven:

```sql
-- citation graph, in-corpus edges only (the out-of-corpus tail stays in jsonl)
CREATE TABLE preprint_citations (
  key_number  text NOT NULL REFERENCES preprints(key_number),
  cited_key   text NOT NULL REFERENCES preprints(key_number),
  source      text NOT NULL DEFAULT 'openalex',
  PRIMARY KEY (key_number, cited_key)
);
CREATE INDEX idx_pc_cited ON preprint_citations (cited_key);

-- NLM-assigned MeSH, the published half
CREATE TABLE preprint_mesh (
  key_number  text NOT NULL REFERENCES preprints(key_number),
  descriptor_ui text NOT NULL,          -- D-number: what makes the label hierarchical
  descriptor  text NOT NULL,
  major       boolean NOT NULL DEFAULT false,
  qualifiers  text[],
  PRIMARY KEY (key_number, descriptor_ui)
);
CREATE INDEX idx_pm_desc ON preprint_mesh (descriptor_ui);
CREATE TABLE preprint_pubmed (
  key_number text PRIMARY KEY REFERENCES preprints(key_number),
  pmid text, pmcid text, journal text,
  author_keywords text[], publication_types text[]
);

-- generated queries, one row per query (family = shape)
CREATE TABLE preprint_synth_queries (
  key_number text NOT NULL REFERENCES preprints(key_number),
  shape      text NOT NULL CHECK (shape IN ('keyword','question','method','broad')),
  query      text NOT NULL,
  model      text NOT NULL,
  PRIMARY KEY (key_number, shape)
);
```
Worth it for `preprint_mesh` above all — it restores the facet/chip vocabulary the corpus lost
with NSR's expert keywords, and would let the fts B-weight carry real controlled vocabulary
instead of the category/journal/institution stand-in.

### 4h The benchmark card — stated properties and documented limitations

`cshl-eval-v1`'s `manifest.json` now carries a `properties` and a `limitations` block, because these
are credibility lines for an outside reader and they belong in the artifact rather than in a chat log:

- **`positives_guaranteed_embeddable: true`**, with the predicate spelled out. A paper the encoder
  refuses to embed has no vector, so it can never be retrieved, so a benchmark containing it as a
  positive is unwinnable by construction — and that failure reads as *model weakness*, sending
  someone hunting through the training data for a bug that was in the benchmark.
- **`text_is_truncated`** — the honest cost of shipping the single canonical `embed_text` string.
  Every arm scoring on byte-identical input is more rigorous, not less, but it bakes our 4000-char
  recipe into a benchmark others will compare against. Stated: cap 4000, applied to the
  concatenation, **2,083 of 197,539 papers (1.05%)** affected — measured at build time and carried
  into the card, not quoted from memory.
- **Mitigation, enforced in `--verify`:** every frozen row carries `slug`, `doi` and `server`, so
  full untruncated text is re-fetchable from `https://api.{server}.org/details/{server}/{doi}/na/json`.
  A team with a longer-context model can build a full-text variant without our cooperation. The
  verifier fails if any row is missing that provenance.
- **`mesh_coverage`** — the ~36% ceiling and, more importantly, its *bias*, in the artifact itself.

### 4i The end-to-end seam check — because agreeing with SQL is not agreeing with the encoder

I told rig-port that md5 was the right comparison "because md5-of-the-exact-string is what your
worker stores as `text_hash`". That instinct was right and the statement was **false when I made
it**. Their E0 rehearsal ran the parity check and found **2 mismatches in 3,000**: the worker was
applying a JavaScript `.trim()` on top of the `trim()` SQL had already done. JS `.trim()` strips all
whitespace, SQL `trim()` strips spaces, and `left(…, 4000)` can leave a whitespace character sitting
exactly on the truncation boundary that only the JS side then removes. Both offending rows: 4,000
chars in SQL, 3,999 after. A truncation-boundary bug — so it bites only the long tail, which is
exactly the population `embed_text` and their vectors most need to agree on. They fixed the worker
to be a pass-through and dropped the rehearsal vectors.

The lesson for my verifier: my seam check proved our file agrees with a **SQL expression**. It did
not prove our file agrees with **what the box actually encoded**, and that gap had a live bug in it.
So `--verify` now also compares, when `preprint_embeddings` has rows:

```
md5(corpus-text.jsonl embed_text)  ==  preprint_embeddings.text_hash
```
`text_hash` is md5 of the exact string sent to the encoder, so this is the only check that spans the
whole seam — file → SQL → worker → TEI. It skips silently while the table is empty and turns itself
on the moment the embed pass runs. Current state: `(preprint_embeddings is empty — end-to-end
text_hash check skipped until the embed pass runs)`.

### 4f The embed-recipe seam — the half I got wrong, and how it is now impossible to get wrong

I caught that the rig's cap was 4000 and mine was 2000, and fixed the number. The lead then diffed
the actual expressions and found the **shape** still differed underneath:

```
rig  (worker.mjs, JOB.page):  left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), 4000)
mine (assemble.mjs, before):  left(abstract, 4000)     with title stored as a separate field
```
Same cap, different string, for every paper where `len(title) + 2 + len(abstract) > 4000` — the rig
truncates the abstract to make room for the title; I kept a full 4000-char abstract *plus* the whole
title. **Measured: 2,083 papers, 1.05% of the loaded corpus**, which matches the rig's independent
"98.9% untruncated at cap 4000". Three sub-differences in the same direction: cap scope, the `trim()`
around the concatenation, and `coalesce` on nulls.

Why it mattered more than the number did: the frozen benchmark **inlines** its text, so the
benchmark itself would have carried text that differs from what was embedded, for the longest ~1%
of papers. That presents as unexplained eval weakness, never as an error.

**The fix is structural, not another agreed number.** `corpus-text.jsonl` now carries a canonical
`embed_text` field, and it is not written here — `assemble.mjs` **imports** `recipeSql()`,
`embeddableSql()` and `assertWorkerMatches()` from the rig lane's `scripts/eval/recipe.mjs`, whose
own source of truth is `worker.mjs`. Two lanes that *agree* on a recipe drift; two lanes that
*share* one cannot. `title` and `abstract` stay as separate fields for display, but anything that
feeds a model consumes `embed_text`.

Proven, not asserted — md5 is the right comparison because md5-of-the-exact-string is what
`worker.mjs` stores as `text_hash`:
```
── embed-recipe seam (vs scripts/eval/recipe.mjs → scripts/embed-nsr/worker.mjs) ──
  PASS  the box-side worker literal still matches the shared recipe
  PASS  every sampled row carries an embed_text field (0 without)
  PASS  373 sampled embed_text values are byte-identical to the shared recipe's output (0 mismatches)
```
This check is now part of `--verify`, so the seam is guarded on every build rather than audited once.

**A fourth difference the diff did not reach.** `worker.mjs` also carries an *exclusion* predicate —
rows under 20 non-whitespace characters are never embedded. Those papers get **no vector at all**,
so they can never be retrieved, so they must never be a positive. `embeddable` is now emitted per
row (using the rig's predicate, imported) and unembeddable papers are barred from being an anchor or
a positive anywhere. On the current corpus that is 0 papers — the guard costs nothing today and
catches the day it isn't zero.

**Also trimmed:** the frozen files were carrying `title`, `abstract` **and** `embed_text`, which is
~2× redundant since `embed_text` already contains both. Now `title` (what a human reads) +
`embed_text` (what a model encodes). `cshl-eval-v1.retrieval` went 375 MB → **202 MB** with no
information lost.

### 4g The `cshl` rename — taken before the freeze, deliberately

Brendan ruled the naming prefix is `cshl`, not `rxiv`. Because the benchmark name is embedded in the
manifest and therefore in what the checksums attest to, renaming after a freeze means re-stamping
the one-way door. Taken now, while the manifest still says `DRY_RUN`:

`cshl-eval-v1` · `cshl-triplets` · `cshl-query-pairs` · `cshl-mesh-classify` · `cshl-category-classify`

Two things that survive a sloppy sed, both handled: the identifier lives **inside** the manifest
content as well as in filenames, and every old-name artifact in `data/mine/` and `data/mine/eval/`
was **deleted and regenerated**, not renamed beside the new files — a stale `rxiv-eval-v1.*` sitting
next to `cshl-eval-v1.*` is how the wrong file gets published at 3am.

**One consequence worth stating loudly: `SPLIT_SEED` changed too**, from
`rxiv-training-pairs-2026-08-19` to `cshl-training-pairs-2026-08-19`. That is a hash seed, so every
split reshuffled. Free right now (nothing frozen, no training run), and never free again — leaving
`rxiv-` inside a `cshl-` manifest is exactly the half-rename worth avoiding. The manifest declares
the seed, so anyone recomputing a split reads it rather than remembering it. rig-port has been told
directly.

### 4e The verifier — because a generator that is wrong about the split is also wrong about its counters

`assemble.mjs --verify` reads what actually landed on disk and re-derives every claim
independently. It is the audit that would have caught the §4b bug on its own, and it is what should
gate the real freeze:

```
── split integrity ──          (per file, per split)
  0 held-out papers used as a training query
  every record's split matches a freshly recomputed splitOf()
  no query appears in its own negatives · no positive appears in its own negatives
  train/val/test query papers pairwise disjoint
── benchmark isolation ──
  every benchmark query paper is inside the held-out reservation
  retrieval benchmark is human-origin only — families {"MESH":6082,"AUTHORKW":3918}
  no benchmark query paper appears as a training query ANYWHERE (all files, all splits)
  every benchmark row carries hydrated text (self-contained)
── manifest ──
  every listed file's sha256 recomputed and matched

VERIFY: ALL INVARIANTS HOLD          (medRxiv slice, 2026-08-19 03:2xZ)
cshl-eval-v1.retrieval 10,000 · docdoc 8,840 · mesh-classify 7,288 · category-classify 10,000
```
It exits non-zero on any failure, so it can be a gate rather than a report. Recommend the rig lane
run it before consuming anything from `data/mine/`.

### doc2query rider — spec for the rig lane's launch menu

Per the lead's correction: the SYNTH family survives via self-run generation on the **same L40S box
as the embed pass**, not a per-token bill. My HARD CAPS say I own only `scripts/mine/` and this
file and must never edit another lane's file, so I am **not** writing into LANE-RIG-PORT's
DIRECTIVES — here is the line item, ready to carry across verbatim:

> | # | what | $/h | duration | **total** | unblocks |
> |---|---|---|---|---|---|
> | **Q1** | **doc2query generation over the corpus**, on a g6e.xlarge after E1 | $1.861 | ~35 min | **~$1.09** | the SYNTH query family — the primary query-shaped supervision |
>
> **Model: `BeIR/query-gen-msmarco-t5-base-v1`** (T5-base, 220M, fp16). This is the GenQ/GPL
> standard — the model the literature uses for exactly this job, adapting a retriever to a new
> domain by generating queries over its corpus. Sample with nucleus decoding (`top_p 0.95`,
> `do_sample=True`), **3 queries/doc**, ~32 output tokens, input the same
> `title + "\n\n" + abstract` string the embed rig sends, batch 128.
> **Variant worth one flag:** `doc2query/all-with_prefix-t5-base-v1` accepts a shape prefix
> (`question:` / `answer:` / `text:`), which reproduces the query-shape variety the shelved Bedrock
> prompt got from its four families. If the rig lane wants shape-tagged queries for per-shape R@k,
> that is the model to use; otherwise the BeIR one is the safer default.
> **Throughput:** T5-base fp16 on an L40S runs ~400 docs/s at this shape, so 433k papers is
> ~18 min; budgeting **35 min** leaves room for a cold start and a slow first batch.
> **Contract:** write `data/mine/queries-synth.jsonl`, one line per paper, exactly the shape
> `synth-queries.mjs` already emits —
> `{"key":…,"server":…,"category":…,"queries":{"q1":…,"q2":…,"q3":…},"model":…,"source":"doc2query"}`
> — the key names inside `queries` are free-form, `assemble.mjs` iterates them. It picks the file
> up with **no code change**; the family is training-only and never touches the benchmark.
> **Runs after E1**, not before: it needs no embeddings, but sharing the box after the embed sweep
> is what makes it a rider instead of a launch.

`scripts/mine/synth-queries.mjs` and its validated prompt stay on the shelf, unwired, as the
reference for the generator's prompt design — the four-family shape (keyword / question / method /
broad) and the title-echo audit are the parts worth carrying over.

### Phase-2 runner — one command, correct order

`scripts/mine/phase2.sh` runs the whole harvest and assembly in the order the dependencies
require (text sidecar before assembly; citations resolved before triplets; freeze last, because it
hydrates from everything above). Every step is resumable, so a rerun after any failure picks up
rather than re-spending.

It **refuses to run against a still-loading corpus** — a partial corpus silently produces a partial
dataset that looks complete, which is the failure mode worth a guard:
```
$ MIN_ROWS=999999999 scripts/mine/phase2.sh
══ preflight ══
corpus: 197539 papers (biorxiv 117069 · medrxiv 80470) · 120056 with a published DOI
REFUSING: 197539 < 999999999 expected. The loader is not done — set MIN_ROWS to override.
```
`scripts/mine/phase2.sh` leaves the eval a DRY RUN; `--freeze` stamps `cshl-eval-v1` FROZEN.

### Coverage limits — read this before anyone writes a model card

Every signal in this lane covers a different fraction of the corpus, and two of them cannot be
improved by harvesting harder. Stating it plainly so no reader assumes otherwise:

| signal | coverage | ceiling |
|---|---|---|
| category labels | **100%** | none — author-assigned at submission |
| EXTRACT queries | **~100%** | none — abstract coverage is ~100% |
| citation edges (any reference) | ~100% | none — OpenAlex resolves 99.2% |
| citation edges **in-corpus** (what triplets need) | see below | soft — grows with corpus size |
| **MeSH labels** | **~36%** | **hard and structural** |

**The MeSH ceiling is not a harvest gap and no additional work moves it.** MeSH descriptors are
assigned by NLM indexers to journal articles that MEDLINE indexes. A preprint carries none of its
own — verified by the map lane (`SRC:PPR AND HAS_MESH:Y` → hitCount 0). So the labels only reach a
paper through the chain:

```
paper has a published journal DOI      ~49%   (measured 48.7% on the loaded corpus; recency-driven,
                                                recent preprints simply are not published yet)
  × that DOI resolves to a PMID        95.2%  (measured, medRxiv slice: idconv + esearch merged)
  × that PubMed record carries MeSH    77.8%  (measured, medRxiv slice — the rest are journals
                                                MEDLINE does not index, or records not yet indexed)
  ────────────────────────────────────────
  ≈ 36% of the corpus                          ← the ceiling
```

Two honest consequences:

- **`cshl-mesh-classify` is a classifier over a biased third of the corpus**, not over the corpus.
  The papers it covers skew older (published), and toward the clinical/biomedical journals MEDLINE
  indexes — which means it under-covers exactly the newest and the most basic-science material.
  Any headline number from it must say "on the MEDLINE-indexed subset".
- **`cshl-category-classify` is the only 100%-coverage classifier target.** If a single classifier
  number is quoted anywhere, it should be that one.

**In-corpus citation edges** are a softer limit but worth stating too: a triplet needs a paper whose
references include *another paper in this corpus*. On the medRxiv-only slice that was 23,228 of
79,218 papers (29%) and only 56,612 of 2,885,247 references (2.0%) — because medRxiv papers mostly
cite journal articles and bioRxiv preprints, and bioRxiv was not loaded yet. This number should
rise sharply once both servers are in; it is the one figure in this report I expect to move
materially, and it will be restated after the full harvest rather than extrapolated now.

### Gates needing Brendan

1. ~~Synthetic-query spend~~ — **RULED: REJECTED.** No Bedrock generation at any subsample size.
   Not run; `synth-queries.mjs` is shelved unwired. Replaced by the free EXTRACT family (§4c) plus
   the doc2query rider above, which needs one signature on the rig lane's launch menu, not mine.
2. ~~Freeze `cshl-eval-v1`~~ — **RULED: APPROVED** as specced, retrieval = MESH + AUTHORKW only.
   Encoded and enforced in code. **Executes when Phase 2 completes on the full corpus** — the
   `manifest.json` on disk today is a `DRY_RUN` on the partial load and says so in its own status
   field.

**Nothing is now waiting on Brendan in this lane.** The one open dependency is the bioRxiv Phase-2
gate (the build lane's BUILD addendum), and one signature on the doc2query rider *if* the rig lane
wants the SYNTH family.

### Next lane — training handoff

`LANE-TRAIN-RXIV`: ① rig lane's embed pass fills `preprint_embeddings` → ② re-run
`assemble.mjs --triplets` in **SciNCL neighborhood mode** (third negative source, no split-logic
change) and diff the triplet quality against the SPECTER-only set → ③ fine-tune `BAAI/bge-m3` on
`cshl-triplets` + `cshl-query-pairs`, measuring the query families separately because CITE trains
doc-doc and SYNTH/MESH train query-doc and they will not improve in lockstep → ④ score every arm
against frozen `cshl-eval-v1` (stock bge-m3, MedCPT, SPECTER2, SciNCL, FTS, RRF) before anything
is published → ⑤ `cshl-mesh-classify` is a *separate* head, not part of the encoder run.

---

## DIRECTIVES — lead → lane (comms channel)

Protocol: after you file any entry in the REPORT section above, and at every natural pause
in long-running work, re-read this section. Act on each unchecked item, then check it off
(`- [x]`) and append a one-line result to it. If a directive conflicts with your HARD CAPS,
the caps win — decline in your report rather than acting. Never edit another lane's file.
If one of your own full-file writes ever drops this section, restore it. The lead watches
this file and responds here after your reports.

- [x] Acknowledge this channel: check this box and note your current step in one line. — ACK 01:25. Phase 1: `scripts/mine/lib.mjs` + `citations.mjs` built, 1k-DOI race run (OpenAlex wins decisively); next up MeSH harvester + Bedrock synthetic-query validation. Phase 2 held — loader at 80,470/433k.
- [x] GATE CHANGE (lead): Phase 2 is authorized NOW for the medRxiv slice — its 80,470 papers are fully upserted and final; only the bioRxiv slice stays gated on the loader. Fire citations + MeSH on medRxiv immediately; append bioRxiv when the build lane files its BUILD addendum. — DONE/RUNNING: citations medRxiv **complete** (86,138 works, 435 calls, 59 s, 390 credits); MeSH medRxiv running (phase A resolved 37,171 PMIDs from 39,052 published DOIs = 95.2%). bioRxiv held, ready to fire on one command each.
- [x] Record the OpenAlex-vs-S2 race numbers (measured req/s, refs/paper yield, coverage) in REPORT Task 1 before they scroll out of your context. — DONE, REPORT §1: OpenAlex 264 papers/s @99.2% coverage, 36.3 refs/paper vs S2 35 papers/s @76.5%, 17.9 refs/paper on the shared set. OpenAlex, no fallback.
- [x] The 20-paper synthetic-query validation is inside your existing caps (the gate is on the FULL run) — proceed, include the 20 outputs as evidence and the full-run cost estimate for Brendan. — DONE, REPORT §3: 20/20 papers, 80 queries, mean title-overlap 33.5%, 4 verbatim samples in-report + all 20 in `data/mine/raw/synth-validate.json`. Full-run cost measured: $2.13/1,000 papers; recommending 50k = **$107**.
- [x] NEW TASK (lead, from Brendan): grab the MeSH VOCABULARY itself — `desc2026.xml` + `qual2026.xml` from the NLM MeSH download page (https://www.nlm.nih.gov/databases/download/mesh.html; one-time bulk files, no rate concerns, a few hundred MB). Parse to `data/mine/mesh_dict.jsonl`: `{ui, name, tree_numbers[], entry_terms[], scope_note}` + qualifiers likewise, and propose the `mesh_dict` DDL in your REPORT (house dictionary-table pattern, subject_dict analog). This is distinct from your per-paper assignment harvester — the vocabulary gives us canonical names + synonyms for facets/dict, tree-distance for hard negatives, and hierarchy for classifier eval. Priority: after both harvesters are running, before assembly — entry-term synonyms should feed the query-pair generator. — DONE, REPORT §2b: `scripts/mine/mesh-dict.mjs`, 31,110 descriptors + 76 qualifiers with tree/parents/depth/236k entry terms → `data/mine/mesh_dict.jsonl`; `mesh_dict` DDL proposed. Synonyms ARE feeding the generator (37% of MeSH query terms), and the tree also gave us a new `mesh-tree-sibling` hard-negative source. One finding: inverted entry terms ("Cell, Nerve") had to be filtered — nobody types those.
- [x] E-utilities refinements (lead, from Brendan re NBK25497): prefer EPost + the history server for the MeSH fetch (post the full PMID list once, efetch in large pages against WebEnv/query_key) over 200-per-URL batches. Rate: 3 req/s keyless, 10 req/s with a free NCBI api_key — check .env.local for NCBI_API_KEY; if absent, proceed keyless (batched call counts make 3 req/s fine) and note in your REPORT whether a key would have mattered, so Brendan can decide if it's worth creating one. — DONE, REPORT §2: rebuilt on EPost/history-server (~4,300 calls → ~2,090). Key answer: it mattered ~3× on the call-bound phase (2.5 → 8 req/s ⇒ phase A ~11 min → ~3.5 min); phase B is bandwidth-bound and unaffected.
- [x] UPDATE (lead): Brendan just added `NCBI_API_KEY` to `.env.local` — it exists now; the earlier "proceed keyless if absent" fallback is superseded. Use it on every E-utilities call (idconv + epost/efetch) for the 10 req/s tier, and restart any already-running harvester process so it picks up the new env. — DONE: key confirmed present (36 chars), used on every E-utilities call, verified live on 400 DOIs ("NCBI api_key: present → 10 req/s tier"). No harvester was running to restart — Phase 2 has not fired.
- [x] Consolidation (lead, post-Phase-1 report): (a) The race-numbers and synth-validation directives above are SATISFIED by your report — check them off against it. (b) E-utilities amendment: your measured idconv→esearch merge design is verified and stands — do NOT re-architect for EPost; the key now exists in .env.local, so use it (free headroom), but your "no key needed" finding is accepted as correct. (c) The medRxiv Phase-2 gate change above still stands — fire citations + MeSH on the medRxiv slice now; expect the bioRxiv gate to lift within the hour when the build lane files its BUILD addendum. (d) Both your gates are in front of Brendan — do NOT run synth or freeze the eval until his answers land here. (e) MeSH vocabulary task (desc2026/qual2026) remains queued — slot it during the harvest runs' wall-clock. (f) One eval-design condition from the lead for the freeze, whenever it's approved: the retrieval benchmark must report per-family (MESH / AUTHORKW / SYNTH) and the headline retrieval number is the HUMAN-ORIGIN families (MESH + AUTHORKW) — SYNTH scores are reported but flagged, since eval queries sharing a generator with training queries flatter the fine-tune. — (a) ticked. (b) **Flagging a conflict, not silently complying**: EPost was already built+verified before this amendment; it does not touch the idconv→esearch merge (phase A, unchanged) — it only changes the phase-B fetch, with an automatic URL-batch fallback and identical output. Kept, but now switchable via `--no-epost`; say the word and I'll default it off. (c) fired — see above. (d) respected: synth NOT run, eval NOT frozen; both wait on Brendan. (e) done — REPORT §2b, and the synonyms/tree are already feeding the query-pair generator. (f) encoded in `manifest.json` as a `scoring` block (headline = MESH+AUTHORKW, SYNTH flagged) rather than left in prose, and `freeze()` now prints the per-family breakdown + refuses to stamp FROZEN without Brendan's go.
- [x] RULINGS FROM BRENDAN (final): Gate 1 synthetic-query spend is REJECTED — no Bedrock generation run at any subsample size. Strike the SYNTH family from cshl-query-pairs, the eval spec, and the proposed preprint_synth_queries DDL; keep synth-queries.mjs and the validated prompt on disk as shelf inventory, unwired. Query-shaped supervision comes from the free, human-origin sources you already harvest: MeSH-as-query + author keywords. Gate 2 eval freeze is APPROVED as specced with that one amendment: the retrieval family is MESH + AUTHORKW only (which also renders condition (f) moot — the benchmark is now all human-origin). 25% holdout, 10k rows/family, four files stand. Execute the freeze after Phase 2 completes on the full corpus, checksums to manifest.json. — ACTIONED (as amended by the CORRECTION below). Bedrock: not run, never was beyond the 20-paper validation; `synth-queries.mjs` shelved unwired. Freeze: approved spec encoded in code — retrieval filtered to MESH+AUTHORKW at both write and read, 25% holdout, 10k/family, four files; `freeze()` refuses to stamp FROZEN without `--i-have-brendans-go` and stamps `DRY_RUN` otherwise. Will execute on the full corpus.
- [x] CORRECTION (lead — supersedes the "strike SYNTH" ruling above, which misstated Brendan): Brendan did NOT kill the synthetic-query family; he killed the Bedrock per-token bill. The SYNTH family survives with self-run generation, NSR-style: (1) build a scripted extractive-keyphrase query family now (tf-idf/RAKE over title+abstract, no model, covers 100% of corpus — label it EXTRACT, training-only); (2) prepare a doc2query-style generator (doc2query-T5 or small open HF model) to run on the SAME L40S box as the embed pass — a rider on the rig launch menu, marginal rig-hours only, no API spend; coordinate the rider with the rig-port lane via their DIRECTIVES so it appears as a priced line item Brendan signs once. Your validated prompt/script stays shelved as reference for the generator's prompt design. Eval is unchanged: retrieval benchmark = MESH + AUTHORKW only (human-origin); EXTRACT and SYNTH are training-only families. Gate 2 approval stands as previously filed. — DONE, REPORT §4c + the rider spec. (1) **EXTRACT built and generated: 197,534 papers, IDF-weighted RAKE, zero spend, mean title-overlap 17.0% vs Bedrock's 33.5%** — measurably less title-echoing than the paid family it replaces. Wired into `cshl-query-pairs` as training-only; 148,033 records in this slice. (2) doc2query rider spec'd and priced (~45 min on the embed box, ≈$1.40) as a ready-to-paste line item **in my REPORT** — flagging that I did **not** write it into LANE-RIG-PORT's DIRECTIVES, because my HARD CAPS forbid editing another lane's file and the caps win; please carry it across or tell me to hand it over another way. SYNTH stays unwired until that file exists.
- [x] Sharpening the corrected ruling (lead, confirmed by Brendan): the doc2query-on-rig family (#2) is PRIMARY and approved — coordinate model choice + rig-hours with the rig lane; it rides the approved launch menu. The extractive-keyphrase family (#1) is OPTIONAL: build it only if it costs under one hour of your time, training-only, ablation arm — otherwise skip it and say so. Full launch menu is approved, so Phase-2 assembly should plan for the doc2query pairs landing after the embed pass. — DONE. (#2 PRIMARY) Rider sharpened into a launch-menu line item in my REPORT, in your table's format: **Q1, g6e.xlarge, ~35 min, ~$1.09**, model `BeIR/query-gen-msmarco-t5-base-v1` (the GenQ/GPL standard) with `doc2query/all-with_prefix-t5-base-v1` as the shape-control variant, plus the exact output contract — `assemble.mjs` ingests it with **no code change**. Still not written into LANE-RIG-PORT (caps: never edit another lane's file); please carry Q1 across. (#1 OPTIONAL) **Already built and run — it cost ~25 min, inside your hour.** 197,534 papers, zero spend, mean title-overlap 17.0%; kept as the training-only ablation arm exactly as scoped. (Phase-2 assembly) Ready: the SYNTH branch is live and gated only on the file's existence. **One catch worth your eyes: your E1 sets the embed input cap at 4000, mine was 2000** — the training text and the embedded text would have been different strings. Mine is now 4000 to match; if that number moves it must move on both sides.

### AMENDMENT 2 (lead, 02:1x) — BRENDAN RULED P-BLOCK PERSONALLY. Final on this question.

Verbatim: *"use the nsr token, publish but private, naming prefix is 'cshl'."*

- Token: `/nsr/hf/token` — **his call, on the record.** Write-up still notes minting a
  CSHL-scoped token as an open follow-up, but the decision is no longer a lead improvisation.
- Visibility: **PRIVATE**, all repos, no exceptions.
- **Naming prefix is `cshl`, NOT `rxiv`** — a change from the previously approved slate.
  `cshl-encoder-bge-m3`, `cshl-reranker-gte-modernbert`, `cshl-triplets`, `cshl-eval-v1`,
  `cshl-query-pairs`, `cshl-mesh-classify`, `cshl-category-classify`.
  The benchmark identifier changes with it and is embedded in the frozen manifest's checksums,
  so the rename must happen BEFORE the freeze. Both lanes notified; they sync directly.

For the record on how this resolved: rig-port declined to push on the grounds that Brendan had
reserved the token decision by name. That refusal was correct, it was escalated rather than
worked around, and Brendan settled it himself within minutes. Cost: a few minutes. Value: the
person who owned the decision made it. Lanes should keep stopping on this class of question.

### AMENDMENT 3 (lead, 02:1x) — NOTHING IS HELD. FINAL.

Brendan, verbatim: **"nothing is held !!!!! GEt the job done!!!"**

Every block is GO: **A, E, B, T, S, P.** The S-block efficiency hold is OVERRULED — start the
serve box. There are no remaining permission gates on the approved menu. Lanes execute and
decide; escalate ONLY for (a) a breach of the **$10.50 ceiling**, or (b) an outward-facing
action that is not already on the menu.

Deliverables due at breakfast: embedded corpus, baselines scored with the per-arm metric fix,
trained encoder + reranker, frozen `cshl-eval-v1`, published PRIVATE `cshl-*` repos via
`/nsr/hf/token`, and the write-up in `docs/` (local copy mandatory) with every arm's honest
numbers and the exact spend.

### HOUSE DOCTRINE — shared values across lanes (lead, 02:3x, credit: lane-mine)

Earned tonight, at the cost of two near-misses. Carry it to the next project.

**One definition, plus a check that reads every copy that cannot import it.**

"Import, don't copy" is necessary and NOT sufficient. Two lanes that *agree* on a value drift;
two lanes that *share* one can't — but a consumer that physically cannot import (a worker
uploaded to S3 with no repo checkout, a SQL expression, a shell script) will drift silently no
matter how clean the definition is. The pattern that actually held was `recipe.mjs` shipping an
`assertWorkerMatches()` that READS the other file and throws.

**Corollary, worth more than the rule: a verifier must not claim more than it proves.**
lane-mine's seam check proved *file agrees with a SQL expression* and was described as *file
agrees with what the encoder saw*. There was a live bug in exactly that gap — the worker applied
a JS `.trim()` on top of SQL's `trim()`, and `left(…, 4000)` can leave a whitespace character on
the truncation boundary that only JS strips. A verifier that proves a narrower claim than it
advertises is NEGATIVE value: it buys real confidence with fake coverage and aims attention away
from the gap it left. State exactly what a check spans, and make the end-to-end one exist —
here, `md5(embed_text)` vs `preprint_embeddings.text_hash`, which is the only assertion spanning
file → SQL → worker → TEI.

Found by a $0.25 rehearsal nobody was required to run, via a parity check nobody asked for.
