# CSHL-CPT — the RxivGPT model program

*Night of 2026-08-19. Modelled on `docs/NSR-CPT-REPORT.md`, which covers the sibling
program on nuclear-science literature.*

> **Status: IN PROGRESS — this document is being written as the runs complete.**
> Sections marked `PENDING` have not been measured yet. Nothing in this file is a
> projection presented as a result; where a number is projected it says so.

---

## Headline

`PENDING — written once the benchmark has been scored.`

## Spend ledger (ceiling $10.50)

| # | item | status | $ |
|---|---|---|---:|
| A1 | AWS scaffolding (IAM role, SG, S3 bucket, SSM SecureString) | done | $0.00 |
| — | eval sidecar tables (4) | done | $0.00 |
| — | aborted MedCPT rehearsal, terminated 35 s in on a permissions contradiction | done | $0.03 |
| E0 | 3,000-row bge-m3 rehearsal | **done** | $0.25 |
| E1 | full corpus embed pass 1 (197,539 rows) | **done** | $0.40 |
| E1b | pass 2, bioRxiv remainder (228,813 rows) | **done** | $0.58 |
| E1c | `RECLAIM_STALE` pass, 3,207 stale rows | **done** | $0.00 (warm box) |
| E2 | HNSW index, 433,449 vectors | **done** | ~$0.05 (Neon) |
| B1 | MedCPT article encoder, 433,449 | **done** | $0.37 |
| B2 | SPECTER2 | running | `PENDING` |
| B3 | SciNCL | running | `PENDING` |
| E2 | HNSW index | pending | `PENDING` |
| B1–B3 | MedCPT / SPECTER2 / SciNCL baseline corpus embeds | pending | `PENDING` |
| Q1 | doc2query synthetic-query generation | pending | `PENDING` |
| T1 | encoder fine-tune | pending | `PENDING` |
| T2 | re-embed with the fine-tune | pending | `PENDING` |
| T3 | reranker fine-tune | pending | `PENDING` |
| S1 | serve box (t3.large, ongoing $0.083/h) | pending | `PENDING` |
| P1 | HF publish (4 private repos, t3.small ×4) | pending | `PENDING` |
| | **TOTAL** | | **$1.63 committed, 2 boxes in flight** |

---

## E0 — the rehearsal, and the two defects it paid for

The rehearsal exists to turn a projection into a measurement. It did that, and it also
caught two things that would each have been far more expensive after the full sweep.

**Throughput.** 3,000 rows embedded end-to-end in ~6 s on one g6e.xlarge (L40S, TEI,
bge-m3 fp16, 4 lanes, cap 4000) — roughly **500 rows/s including worker startup**, against
a projection of 250–325 rows/s derived from NSR's measured token throughput. So the
projection was conservative by ~1.6×. Caveat, stated plainly: 6 seconds is too short to
reach steady state, so treat 500 rows/s as a floor and E1's own number as the real one.

**Vector quality: clean.** 3,000/3,000 at dim 1024, `model='bge-m3'` on every row, zero
zero-vectors, L2 norms exactly 1.00000, 3,000 distinct text hashes, and a kNN self-probe
returning the probe paper at cosine distance 0.0000 with sane neighbours (0.248, 0.308).

**Defect 1 — `text_hash` did not mean what it says.** The parity check
(`text_hash` vs `md5()` of the SQL recipe) returned **2 mismatches out of 3,000**, not 0.
Cause: the worker applied a JavaScript `.trim()` to the string SQL had already built.
JS `.trim()` strips all whitespace; SQL `trim()` strips spaces; and `left(..., 4000)` can
leave a whitespace character sitting exactly on the truncation boundary, which only the JS
side then removed. Both offending rows were 4,000 characters in SQL and 3,999 after a
JS-style trim — the truncation-boundary case precisely.

It is 0.07% of rows and it is not cosmetic. `text_hash` is the *only* mechanism that can
detect a paper whose abstract was rewritten by a later version — `ON DELETE CASCADE`
covers removal, not revision — and the ingest lane and this lane had just agreed that a
`RECLAIM_STALE` pass is mandatory after every incremental walk. A row whose stored hash can
never equal the recomputed hash is re-embedded on every pass, forever, and never converges.
At 433k rows that is ~300 rows of silent churn per pass, in the one column whose job is to
be trustworthy about staleness.

Fixed by making the worker a pass-through: SQL is now the single author of the input
string, and the hash is `md5()` of exactly what is sent to the encoder. The 3,000 rehearsal
rows were deleted so the full sweep produces one internally consistent corpus.

**Defect 2 — the rig hung on `apt`, not on anything it was doing.** Boot wedged for 3+
minutes inside `apt-get update` from the NodeSource repository, with TEI already healthy
and the box billing at $0.031/min. It would have run to the 2-hour watchdog and burned
~$3.72 — a third of the night's ceiling — without embedding a row. Salvaged live over SSM
(Node installed from the official static tarball, worker started by hand), which is where
the throughput number above came from. The rig now installs Node from that tarball in
user-data: no repository, no lock contention, no mirror to hang on. Node exists on that box
to run one script; it never needed a package manager.

The general lesson, which is worth more than either fix: **a rehearsal is not for
confirming that the happy path works.** Both defects were invisible to "did it produce
vectors?" and both were caught by checking an invariant and watching the clock.

## E1 — two bugs that would not have announced themselves

Both were caught in flight, and both belong to the same family: failures that produce a
plausible result rather than an error.

**The sweep was bounded at yesterday's maximum key.** Lane boundaries are computed from the
unembedded set *at launch*. The corpus was still being upserted underneath the run, and the
top lane's upper bound was the largest key that existed at that moment — so every row the
loader added above it would have been silently excluded. No error, no crash, no short count
anyone would notice: just ~236,000 papers with no vector. The first symptom would have been
a dense-recall number that read as *model weakness*, and the search for it would have gone
into the training data, which is the one place it wasn't. Fixed by emitting `L-1` boundaries
on a full run so the top lane is unbounded. Rehearsals keep their bounded top — that is what
makes them a rehearsal rather than a small sweep.

**A comment executed on the laptop instead of the box.** The launcher builds its user-data
with an unquoted heredoc, and a comment I wrote to explain the previous fix contained
`` `apt-get update` `` in backticks. Bash performed command substitution while assembling the
script: the command ran locally, its output was spliced into the comment, and the box
received a mangled line. It was harmless because `apt-get` does not exist on macOS. A
comment containing a destructive command in that position would have run on the author's
machine with the author's credentials, and nothing about the surrounding code would have
looked wrong. The response was to audit the entire heredoc for unescaped `` ` `` and `$(`
rather than to fix the one instance.

Neither of these is exotic. Both are the ordinary consequence of a rig assembled by string
interpolation and pointed at a moving target, and both are invisible to "did it exit zero?"

### E1 pass 1 — measured

| | |
|---|---|
| rows | 197,539 |
| wall-clock (first to last `embedded_at`) | 235.2 s |
| **throughput** | **840 rows/s** across 2 × g6e.xlarge (420/s per box) |
| error lines in the worker log | **0** — no TEI failures, no skips, no reconnects |
| dimension / model / zero-vector faults | 0 / 0 / 0 |
| `text_hash` mismatches vs the recipe | **0 / 197,539** |
| embeddable papers left uncovered | **0** |

Against the pre-flight projection of 250–325 rows/s, the rig ran **~2.6× faster**. The
projection was derived from NSR's measured token throughput on a corpus of much shorter
inputs; it was conservative in the right direction, which is the direction to be wrong in
when the number is being used to decide how much GPU to buy.

The zero-mismatch `text_hash` result is the one worth pausing on: the E0 rehearsal produced
2 mismatches in 3,000 rows, so the same defect would have produced roughly 130 here. It is
the difference between a corpus whose staleness column can be trusted and one where it
quietly cannot.

Note the log evidence specifically. NSR could only offer *data-side parity* for its
equivalent claim, because its box destroyed `/var/log/embed.log` on self-termination. Here
the log was read off a live box mid-sweep, so "0 errors" is an observation rather than an
inference.

## The corpus

Both preprint servers operated by Cold Spring Harbor Laboratory, harvested from the
public bioRxiv/medRxiv APIs.

`PENDING — final counts land with the ingest lane's last upsert.` At the time the embed
rig was prepared: 197,539 papers committed (bioRxiv 117,069 + medRxiv 80,470), walk at
137/154 months, headed for ~433k.

**What makes this corpus different from NSR's, and why it changed the rigs.** NSR was
mostly title-only rows — 93,579 of 277,068 had an abstract at all. This corpus has
**100.0% abstract coverage** (measured: zero rows without an abstract). That single fact
drove three decisions:

1. **The input cap moved from 2,000 to 4,000 characters.** At 2,000 — NSR's setting —
   only 69.2% of documents survive whole. At 4,000, 98.9% do. Measured per server:

   | server | n | p50 | p90 | p99 | whole @2000 | whole @4000 |
   |---|---:|---:|---:|---:|---:|---:|
   | bioRxiv | 117,069 | 1,550 | 2,393 | 3,403 | 79.3% | 99.8% |
   | medRxiv | 80,470 | 1,941 | 2,986 | 4,763 | 54.6% | 97.7% |
   | combined | 197,539 | 1,723 | 2,657 | 4,041 | 69.2% | **98.9%** |

   Cost of the change: mean input length 1,628 → 1,802 characters, **+10.7% of encoder
   tokens**, about eleven cents on a one-dollar sweep. Above 4,000 the curve is flat
   (5,000 buys another 0.7pp of whole documents for +0.3% tokens).

2. **Training passage length moved from 256 to 512 tokens.** Documents average ~430
   tokens at the 4,000-char cap. Training at 256 would have shown the model roughly half
   the text the index actually contains — train and serve would see different documents.

3. **Chunk size per encoder call halved** (128 → 64 texts), because inputs are ~3.5×
   NSR's and 128 long texts in one call overruns TEI's batch-token budget.

---

## Coverage — verified, with a timestamp

A completeness claim without a timestamp is worth very little, because completeness is not a
property a table has — it is a property a table had at a moment, and it decays the instant
any other process touches the table.

```
verified 2026-08-19 07:08:23Z against 433,449 papers

corpus                     433,449   embeddable 433,449   excluded (<20 non-ws chars) 0
preprint_embeddings        433,449 vectors      papers without a vector: 0
dimension faults 0 · zero vectors 0 · text_hash vs recipe: 0 mismatches corpus-wide
preprint_embeddings_medcpt 433,449 vectors      papers without a vector: 0

GATE PASSED
```

`scripts/eval/coverage-gate.mjs` re-derives every figure at assertion time and accepts
nothing from a pass report. It runs again as the last action before publish, because the
run above proves nothing about the state an hour later.

### Why the gate exists: a true report that became false

The pass-1 sweep reported *0 mismatches, 0 uncovered papers*. That was **true when written**.
Ninety minutes later it was false — not because anything failed, but because a neighbouring
lane upserted newer versions of papers already embedded, and the hub keeps latest-version-
wins. The gate caught **3,207** rows whose stored `text_hash` no longer matched the
recomputed recipe. Every one of them was a multi-version paper (v2 1,722 · v3 861 · v4 383 ·
v5 145 · v6 52) against a corpus baseline of 24.5% multi-version — a 100% concentration that
identifies the cause beyond argument.

Nothing errored. The vectors were real, the rows present, every count reconciled. They simply
described text that no longer existed. `RECLAIM_STALE=1` re-embedded exactly those 3,207 on
an already-warm box, and the gate then passed clean.

The generalisation, which now governs how this program reports anything: **any completeness
claim decays the moment a concurrent lane touches the same table.** Not a bug in either lane —
a property of concurrent work on shared state.

*Related finding, credited to the ingest lane:* an unauthenticated `PATCH` handler inherited
from the NSR codebase allowed `UPDATE preprints SET abstract = $2` from the open internet, and
was about to be exposed at cutover. Any request could have silently invalidated a paper's
vector, detectable only by a `text_hash` comparison. Disabled before exposure. A benchmark
whose corpus text is publicly mutable is not a benchmark.

## Retrieval performance — measured, and the number is a range

`idx_pp_emb_hnsw`, HNSW over 433,449 × 1024-d, cosine opclass. Index Scan confirmed.

| condition | server-side |
|---|---|
| warm (probe repeated in-session) | **2.1 ms** |
| warm, `ef_search` 20 / 40 / 100 | 1.4 / 2.4 / 4.5 ms |
| cold (five distinct probes) | **858 – 1,200 ms** |

The spread is cache, not the index: the HNSW graph is **3,411 MB** against **456 MB** of
`shared_buffers` — about **13%** resident. A traversal that lands on cached pages costs
milliseconds; one that doesn't pays storage reads for the whole walk. Reporting a single
latency figure here would be reporting cache luck, so this document reports both ends.

Two levers, neither pulled: keeping the Neon compute floor raised (more memory, more resident
index — in tension with the house rule of restoring it to 0.25 CU at close), and `halfvec`,
which would halve the index and roughly double what fits in cache at some recall cost. The
latter is a re-embed-adjacent change against a frozen, verified corpus, so it is a follow-up
and not a tonight decision.

## Training — what the hardware actually allowed

The plan was one g6e.xlarge (L40S, 48 GB) at `passage_max_len` 512, batch 8, ~40,000 pairs,
about 70 minutes. What happened instead is worth recording precisely, because a benchmark
that hides its constraints isn't reproducible.

**`g6e` had no capacity in any availability zone** — not `xlarge`, not `2xlarge`. The error is
explicit and rotating: each AZ suggests trying the other three. That is capacity churn, not a
configuration fault. `g5.2xlarge` (A10G, **24 GB**) was available, so training ran there.

Consequences, in order:

- `passage_max_len` dropped 512 → **384** to fit 24 GB.
- The OOM-halving loop then took batch 8 → **4**, which is the loop doing its job. 40,000 pairs
  ÷ 4 = **10,000 steps** rather than 5,000, at ~1.22 it/s — about **2.3 hours** instead of ~70
  minutes.

So the encoder was trained on the hardware capacity actually granted, at half the planned
batch and three-quarters of the planned passage length. Both numbers are in the model card.
NSR's winning encoder trained at `passage_max_len` 256, so 384 is still above that precedent —
but it is below what this corpus indexes, and that is a real limitation rather than a footnote.

### Two rig bugs found by the capacity failure

**The AZ-failover had never once executed.** Under `set -e`, `OUT=$(launch_in "$sn")` exits the
script the instant the first zone returns a capacity error — so the loop whose only purpose is
to try the next zone could never be reached. Every launch until this one had succeeded on the
first attempt, so the fallback path had never run. **A fallback that has never been exercised
is not a fallback; it is a comment.**

**The TEI container image was hardcoded to `89-1.8`** (Ada — L40S, L4). A10G is compute
capability 8.6. On a g5 box that container starts successfully and never loads the model: no
crash, no error, a healthy-looking process serving nothing. Now a `TEI_IMAGE` knob.

Both belong to the night's dominant failure mode — code that looks right, raises nothing, and
does the wrong thing — and both were invisible until the path finally had to work.

## Methodology

### The frozen benchmark: `cshl-eval-v1`

`PENDING — freeze happens when the miner lane's harvest lands.` Design, fixed in advance:

- **Split by paper, not by query**, so a paper's queries cannot straddle the boundary.
  25% held out by `md5("holdout:" || key_number) < 0.25`. Measured on the live corpus:
  25.1%.
- **Frozen before any training.** The same hash rule is used by the benchmark builder,
  the encoder triplet converter and the reranker group converter, and both converters
  audit **what they emit**, not what they read, and refuse to write a set that leaks a
  held-out paper as an anchor, a positive, or a negative.
- Query families, sizes and provenance recorded in the manifest along with the hash of
  the harvest file each family came from.

### Similarity metric is per-arm, and this is not a detail

Each model is scored with the similarity function its authors trained and published it
for:

| arm | metric | pgvector | HNSW opclass | vectors stored |
|---|---|---|---|---|
| bge-m3, and our fine-tune of it | cosine | `<=>` | `vector_cosine_ops` | normalized |
| MedCPT, SPECTER2, SciNCL | **dot product** | `<#>` | `vector_ip_ops` | **raw `[CLS]`** |

Normalizing before a dot product changes the ranking whenever document norms vary. Had
we scored MedCPT with cosine over normalized vectors — the obvious default, and what the
harness did when first written — we would have published three baseline numbers that were
not those models' numbers, in a report whose entire claim is "here is the standard to
compare against." The bug was caught before the baseline runs were paid for, not after.

### Baselines are measured here, not quoted

Every baseline is run on the same corpus, the same queries and the same metric code:
Postgres FTS · stock `BAAI/bge-m3` · `ncbi/MedCPT` (article + query encoders) ·
`allenai/specter2_base` · `malteos/scincl` · our fine-tune · RRF fusions · cross-encoder
rerank stages.

Two honest caveats about the baselines:

- **SPECTER2** proper is `allenai/specter2_base` *plus* a proximity adapter, and TEI
  cannot load adapters. The arm is the base encoder — a legitimate and commonly reported
  configuration, but it is not SPECTER2-with-adapter, and it is labelled that way.
- **MedCPT** truncates articles at 512 tokens (~2,000 characters), so on this corpus it
  sees roughly the 2,000-cap version of every document regardless of our own cap. Its
  number should be read with that in mind.

### The `TITLE` family is a floor, not a result

One built-in query family uses a paper's own title as the query. Because the indexed
document *is* title + abstract, this family is **leaked by construction**. It exists to
prove the harness end to end on day zero and as a floor — an arm that cannot find a paper
from its own title is broken, not merely weak. It is reported separately and never
blended into a headline number. Measured with FTS on a draft freeze: R@1 0.9933.

---

## Results

**Scored on the frozen 2,000-query subsample of `cshl-eval-v1`**
(`sha256 32433e4d95099b964d2d571ab2389ad0a1cc1eeba29670fe5a87e30683cf4594`,
MESH 1,241 · AUTHORKW 759), retrieved against the **full 433,449-paper corpus** —
not against each row's own negatives, which would measure reranking and flatter every arm.
`hnsw.ef_search=100`, single gold per query, so R@k is hit-rate@k.

Why a subsample: the miner lane measured full-10k FTS at ~104 min/arm. Five arms on the full
set was not available in the time. The subsample is deterministic and documented, so it is
reproducible — but **absolute numbers will differ on the full 10,000**, and full-set scoring
is a follow-up rather than a completed claim.

### MESH family (n = 1,241) — NLM controlled vocabulary as the query

| arm | R@1 | R@10 | nDCG@10 |
|---|---|---|---|
| Postgres FTS | 0.047 | 0.081 | 0.063 |
| stock `BAAI/bge-m3` | 0.118 | 0.286 | 0.194 |
| **RRF(FTS + bge-m3)** | **0.136** | **0.317** | **0.218** |
| `ncbi/MedCPT` | `PENDING` | | |
| `allenai/specter2_base` | `PENDING` | | |
| `malteos/scincl` | `PENDING` | | |
| **our fine-tune** | `PENDING` | | |

### AUTHORKW family (n = 759) — author-supplied keywords as the query

| arm | R@1 | R@10 | nDCG@10 |
|---|---|---|---|
| Postgres FTS | 0.217 | 0.240 | 0.229 |
| stock `BAAI/bge-m3` | 0.457 | 0.652 | 0.552 |
| **RRF(FTS + bge-m3)** | **0.491** | **0.684** | **0.589** |
| `ncbi/MedCPT` | `PENDING` | | |
| `allenai/specter2_base` | `PENDING` | | |
| `malteos/scincl` | `PENDING` | | |
| **our fine-tune** | `PENDING` | | |

**Two things already visible, before our own model exists:**

**Dense retrieval dominates lexical on this corpus, by 3.5× on MeSH.** FTS R@10 0.081 against
bge-m3's 0.286. MeSH descriptors are controlled vocabulary assigned by an indexer — they often
never appear verbatim in the paper, so lexical matching has little to match. This is the
strongest argument in the report for the whole dense-retrieval program, and it comes from a
baseline rather than from our model.

**The two families measure different things and must never be blended into one headline.**
Every arm scores roughly 2–3× higher on AUTHORKW than on MESH. Author keywords are written by
the authors of the paper being retrieved, so they plausibly share vocabulary with its abstract;
MeSH descriptors are assigned externally and do not. A single blended number would move with
the family mix rather than with retrieval quality.

**RRF beats both of its inputs on every metric in both families** — consistent with the NSR
program's finding, and it is the configuration production should serve regardless of how our
fine-tune scores.

### Where our model loses

`PENDING — this section is mandatory and will be filled in even if it is long. A report
that only reports wins is worthless.`

---

## Licensing — measured, for the record

Everything publishes **private**, per standing policy — the same posture as the sibling NSR
program's four private repos. Bulk public redistribution is not on the table, so the
question that would otherwise arise here does not.

The measured mix stays in this report and in the cards because it is a fact about the
corpus worth stating, and because a card that gets it wrong is worse than a card that omits
it. Over 197,539 loaded papers:

| licence | share | derivatives redistributable? |
|---|---:|---|
| `cc_by_nc_nd` | 35.5% | no |
| `cc_no` | 29.9% | **no — all rights reserved** |
| `cc_by` | 20.2% | yes |
| `cc_by_nc` | 6.8% | yes, non-commercial |
| `cc_by_nd` | 6.4% | no |
| `cc0` / `cc0_ng` | 1.1% | yes |
| unstated | 0.1% | unknown |

`cc_no` means all rights reserved, not a Creative Commons licence. The card filler
originally computed this with `license LIKE 'cc%'` and would have asserted **"99.9%
Creative Commons"** about a corpus that is ~30% all-rights-reserved — wrong in the direction
that costs credibility rather than accuracy. It enumerates now.

Two things kept, both cheap: the table ships inside the cards, and
`scripts/publish-nsr/launch.sh` refuses to push a text-bearing artifact
(`*triplets*`, `*eval-v1*`, `*corpus*`, `*query-pairs*`) with anything other than
`PRIVATE=True`. That is not a decision pending anyone's input — it is the settled policy
made structural, so it stays settled without depending on memory. If the posture ever
changes, a keys-only release is available at low cost: every frozen row already carries
`doi` and `server`.

Distinct and not at issue: *displaying* abstracts in the search UI with attribution is what
the servers' public API exists for, and the production cutover is unaffected.

## Open follow-ups

1. **The Hugging Face push used the NSR-scoped token** (`/nsr/hf/token`), on Brendan's
   explicit ruling, because minting a CSHL-scoped token needs his account and he was
   asleep. Rotating to a project-scoped credential is an open item. Cross-project
   credential reuse is a blast-radius question, not a style question.
2. **The Neon password should be rotated.** An early dry-run of the embed launcher printed
   the connection string in full before the redaction was added; it is in a session
   transcript. Fixed at source (`redact()` in `scripts/embed-nsr/launch.sh`).
3. **`NSR_*` serving env-var names** (`NSR_ENCODER_URL`, `NSR_RERANKER_URL`,
   `NSR_SERVE_KEY`, `SEARCH_ENCODER=nsr`) are still NSR-prefixed because `api/` belonged
   to another lane. Rename in one commit together with `api/_lib/embed.ts`.
4. **MedCPT as a serving dense arm** needs an `api/` change — `api/_lib/embed.ts`
   hard-fails any vector whose length is not 1024, and MedCPT is 768-d.
5. **Any future incremental walk must be followed by `RECLAIM_STALE=1`.** The hub keeps
   the latest version per paper, so a refresh silently rewrites abstracts under the
   vectors. `ON DELETE CASCADE` covers a paper being *removed*, not *revised*; only
   `text_hash` can see the latter.
6. **Benchmark builder filename** is still `scripts/eval/build-rxiv-eval.mjs` while the
   artifact it builds is `cshl-eval-v1`. Cosmetic; left alone mid-flight to avoid breaking
   another lane's reference.

---

## Provenance

Rigs ported from the NSR program at commit `8c1b05b` (`docs/NSR-CPT-REPORT.md`), which
itself inherited the embed and reranker rigs from 44b. What changed, and why, is recorded
per file in `docs/prompts/LANE-RIG-PORT.md`.
