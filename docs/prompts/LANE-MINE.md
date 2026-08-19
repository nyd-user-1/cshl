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
   - `rxiv-triplets`: SPECTER-style (query=paper, pos=cited-in-corpus, hard-neg=
     citation-of-citation + same-category-not-cited), SciNCL-style neighborhood variant
     NOTED as a follow-up that needs embeddings (flag the dependency — embeddings land
     via the rig lane; design the sampler so it can re-run in neighborhood mode later).
   - `rxiv-mesh-classify`: paper → MeSH descriptors (and the category set as
     `rxiv-category-classify`, free, assembled directly from the DB).
   - `rxiv-query-pairs`: MeSH-as-query + synthetic queries → paper.
   - Eval holdouts for each, split by paper hash, sized per the rig lane's `rxiv-eval-v1`
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

## REPORT (fill in as you go)

- Status:
- 1 Citation harvester:
- 2 MeSH harvester:
- 3 Synthetic queries:
- 4 Assembly:
- 5 Sizing + handoff:
- Gates needing Brendan:
- Next lane:
