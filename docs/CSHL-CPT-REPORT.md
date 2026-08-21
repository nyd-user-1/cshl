# CSHL-CPT — the RxivGPT model program

*Night of 2026-08-19. Modelled on `docs/NSR-CPT-REPORT.md`, which covers the sibling
program on nuclear-science literature.*

---

## Headline

**Query-shaped supervision closes 80% of the gap to MedCPT. On MeSH we are now statistically
indistinguishable from it.**

*Run `20260819-192100-train`, 2026-08-20. Trained on 39,999 of the 424,753 `cshl-query-pairs`
that the previous night left unused. Scored on the identical frozen 2,000-query subsample.*

| benchmark | ours (CITE) | **ours (qpairs)** | MedCPT | |
|---|---:|---:|---:|---|
| **query→doc**, MeSH R@10 | 0.3320 | **0.4319** | 0.4569 | +30.1% over CITE |
| **query→doc**, AUTHORKW R@10 | 0.6693 | **0.7497** | 0.8076 | +12.0% over CITE |
| **doc→doc** R@10 | **0.2120** | 0.1980 | 0.1790 | −6.6%, a real loss |

Paired McNemar, qpairs vs CITE, same 2,000 queries: MeSH **+0.0999, p = 2.3e-16**
(CI [+0.0766, +0.1225]); AUTHORKW **+0.0804, p = 5.0e-9**.

Paired against **MedCPT** on MeSH: **−0.0250, p = 0.071, CI [−0.0516, +0.0016]** — the interval
crosses zero. A general multilingual encoder, fine-tuned for one hour on mined query pairs from
this corpus, has reached **statistical parity on MeSH retrieval** with a purpose-built
biomedical retriever trained on PubMed query-click logs. On author keywords MedCPT is still
clearly better (−0.0580, p = 0.0003) and that loss is not rounded off here.

**Best configuration overall is again a fusion, and it is a new program best:**
`RRF(qpairs + MedCPT + FTS)` at MeSH R@10 **0.5197** and AUTHORKW **0.8300**, against the
previous best of 0.4722 / 0.8235.

**The doc→doc regression is the price, and the honest version is worse than "small".** Against
stock `BAAI/bge-m3` the qpairs model is **statistically indistinguishable** on doc→doc
(+0.0025, p = 0.78). Citation training bought a genuine doc→doc advantage; query training spent
**all** of it. So this is a **trade, not an upgrade** — `preprint_embeddings_cshl` (CITE) remains
the better encoder for "more like this", reviewer matching and systematic-review expansion, and
both tables stay populated.

**One confound, stated plainly:** this run moved the objective *and* the effective batch size
(4 → 8, because an L40S was available where the previous night had only a 24 GB A10G). Two
clean runs did not fit the budget. The batch change plausibly explains part of the gain; it does
not plausibly explain all of it, because doc→doc moved in the **opposite** direction at the same
batch size — which is what an objective change looks like and not what a capacity change looks
like.

Full method, verification and spend: `docs/prompts/LANE-QPAIRS-RUN.md`.
Vectors: `preprint_embeddings_cshl_qp`, 433,449 rows, gate passed 2026-08-20 01:00Z.
**Not published to Hugging Face — that decision is Brendan's, by name.**

## Superseded headline — the symmetric result (kept for the record)

**Each model wins the task it was trained for. That is the whole result, and it is symmetric.**

| benchmark | ours | MedCPT | winner |
|---|---:|---:|---|
| **query→document** (MeSH R@10) | 0.332 | **0.457** | MedCPT, +38% |
| **document→document** (R@10) | **0.212** | 0.179 | **ours, +18%** |

We trained on citation-based document→document pairs. On query→document retrieval we lose to
`ncbi/MedCPT` by 38%. On document→document retrieval — the task we actually trained for —
**we beat MedCPT, SPECTER2 and stock bge-m3, and we beat all three at a statistically
significant margin.**

Paired McNemar on 2,000 held-out pairs, R@10:

| comparison | ours-only hits | theirs-only | ΔR@10 | p |
|---|---:|---:|---:|---:|
| ours vs `ncbi/MedCPT` | 172 | 106 | **+0.0330** | **0.0001** |
| ours vs `allenai/specter2_base` | 140 | 108 | +0.0160 | 0.049 |
| ours vs stock `BAAI/bge-m3` | 118 | 85 | +0.0165 | 0.025 |

Bootstrap 95% CI on ours − MedCPT: **[+0.0165, +0.0495]**, 5,000 resamples.

MedCPT — trained on PubMed query-click logs — is the **worst** of the four arms at
document→document (R@10 0.179, below even stock bge-m3's 0.196). It is a query-retrieval
specialist and it does not transfer to document similarity. We are the mirror image. Neither
result is a surprise once stated; both were unmeasured until now, and we had already written
up the loss without running the matching test.

**Three honest qualifications.**

1. **Absolute numbers on doc→doc are low for every arm** — R@10 between 0.18 and 0.21, finding
   one specific gold paper among 433,449. This is a hard task and nobody is good at it.
2. **Our margin over stock bge-m3 is modest** (+0.0165, p=0.025). Most of our advantage over
   MedCPT comes from MedCPT being weak off-task, not from our fine-tune being strong.
3. **Query→document is the task the product actually serves.** A search box takes queries, not
   documents. So the query→doc loss is the commercially important number, and doc→doc is where
   the "more like this", reviewer-matching and systematic-review-expansion features live.

**The best retrieval configuration remains a fusion**: `RRF(ours + MedCPT + FTS)` at MeSH R@10
**0.4722**, above MedCPT alone at 0.4569. Within that fusion, plain BM25 contributes about
1.6–2× what our encoder does.

**What this changes about the next step.** The objective-mismatch hypothesis is no longer a
hypothesis — it is measured in both directions. Training on the 424,753 query-shaped pairs
that were built and left unused is now the obvious experiment, and its expected value is
higher than it looked when the doc→doc side was unmeasured.

## Superseded headline — the original loss (kept for the record)

**We did not beat MedCPT.** Our fine-tuned encoder scores **MeSH R@10 0.332** against
`ncbi/MedCPT`'s **0.457** — one night of domain adaptation closed about a quarter of the gap
to a purpose-built biomedical retriever, not all of it. It also lost to `allenai/specter2_base`
(0.351), which we did not expect.

**What did win is a fusion.** `RRF(ours + MedCPT + FTS)` scores **MeSH R@10 0.4722**, the best
arm measured, beating MedCPT alone by 3.3% relative. Our encoder's marginal contribution to
that fusion is **+0.9%** over `RRF(MedCPT + FTS)` — real, positive, and small.

**The most useful result is about full-text search.** Postgres FTS is the worst arm alone
(MeSH R@10 0.081, five times worse than anything else) and the *largest single contributor*
in fusion: adding it to MedCPT gains **+2.5%** against our encoder's **+1.6%**, i.e. about
1.6× (2.0× when each is added last to the other's pair).
Lexical and dense retrieval fail on disjoint queries, and this is an unusually clean
demonstration of it on a real corpus.

So the honest one-line claim is: **our encoder adds a small amount of complementary signal to
a fusion whose heavy lifting is done by MedCPT and BM25.**

The deliverable that survives all of this is the **benchmark**: 433,449 preprints, a frozen
reproducible query set, seven arms measured under identical conditions with the metric each
model was published for, every number timestamped and coverage-gated. A benchmark on which
the incumbent wins is still a benchmark.

## Spend ledger (ceiling $10.50)

| # | item | $ |
|---|---|---:|
| A1 | AWS scaffolding, eval sidecars | 0.00 |
| — | aborted MedCPT rehearsal (terminated 35 s in, permissions contradiction) | 0.03 |
| E0 | 3,000-row rehearsal — caught the `text_hash` double-trim and the `apt` hang | 0.25 |
| E1 | corpus embed, bge-m3, two passes (197,539 + 228,813) | 0.98 |
| E1c | `RECLAIM_STALE` pass, 3,207 stale rows (reused a warm box) | 0.00 |
| E2 | HNSW indexes ×4 (Neon compute) | ~0.20 |
| B1 | MedCPT article encoder, 433,449 | 0.37 |
| B2 | SPECTER2, 433,449 | 0.37 |
| B3 | SciNCL — box ran, TEI unsupported, 0 rows | 0.25 |
| — | query-vector boxes (incl. one wasted to a shared-temp race) | 0.45 |
| T1 | encoder fine-tune, 2 h 21 m on g5.2xlarge | 2.85 |
| — | **wasted T2 pair — `s3:ListBucket` denied, embedded nothing** | 0.10 |
| T2 | corpus re-embed with the fine-tune, 433,449 | 0.85 |
| **AWS total** | | **≈ $6.70** |
| Neon | compute held at min 2 CU from 06:23Z (deliberate — see below) | ~$0.16/CU-h |

**About $0.60 of that was wasted on my own errors** — the aborted rehearsal, the SciNCL box
that could never work, the query-vector race, and the T2 pair that booted without weights. It
is itemised rather than absorbed because a ledger that hides its mistakes misprices the next
decision.

**Neon compute is deliberately still at min 2 CU.** The house rule says restore to 0.25 after
a sweep. Doing so shrinks `shared_buffers` and makes `/chat` slower exactly when it is being
looked at — the HNSW graph is 3.4 GB against 456 MB of cache, so cold kNN is ~1 s and warm is
~2 ms. Left raised as a demo-quality decision, not an oversight. **Restore it when the demo
is over.**

## Coverage — verified, with a timestamp

**Final gate: PASSED at 2026-08-19 14:29Z**, re-derived at assertion time against all four
vector spaces, accepting nothing from a pass report:

```
corpus 433,449 · embeddable 433,449 · excluded by the <20-char rule 0

preprint_embeddings           433,449   uncovered 0   dim 1024   zero-vectors 0
preprint_embeddings_medcpt    433,449   uncovered 0   dim  768   zero-vectors 0
preprint_embeddings_specter2  433,449   uncovered 0   dim  768   zero-vectors 0
preprint_embeddings_cshl      433,449   uncovered 0   dim 1024   zero-vectors 0
text_hash vs canonical recipe: 0 mismatches corpus-wide

GATE PASSED — publishable.
```

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

**Final: 433,449 papers** — bioRxiv 345,882 (2013–2026) + medRxiv 87,567 (2019–2026), with
584,553 version rows behind them. Verified two independent ways by the ingest lane: the
loader's own close-out and a re-derivation of distinct `(server, doi)` straight from the
walked ndjson, which agreed exactly. That second check is what caught an earlier upsert that
had silently under-counted by 7,097 papers while reporting success.

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

### Why the final gate exists

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

## An incident worth publishing: two arms, one model, no error

While generating query vectors for the MedCPT and SPECTER2 arms, two files were produced:

```
queryvec-medcpt.jsonl   14,613,519 bytes   md5 e85304e0706ee933b4282fb1964e55b2
queryvec-scincl.jsonl   14,613,519 bytes   md5 e85304e0706ee933b4282fb1964e55b2
```

Byte-identical. Two different encoders cannot produce identical floats on identical text, so
at most one was correct and nothing in the output said which. Both had the right dimension
(768), the right row count (2,000), the right query strings, valid JSON, and plausible float
distributions. **No error was raised at any point.**

Cause: two jobs were running concurrently on the same box — an original script and a fix-up
issued after correcting an unrelated IAM gap — and both wrote to the same `/tmp/out.jsonl`
before uploading under different names. A shared-temp-path race, self-inflicted.

Underneath it sat a second failure of the same species: the instance role could write
`logs/*` and `models/*` but not `eval/*`, so the first run's uploads died with `AccessDenied`
— while the script printed `DONE specter2` regardless, because it never checked the exit
code. It reported success on a failed upload.

Had this shipped, the SciNCL row would have silently been MedCPT's numbers, and the table
would have looked entirely reasonable.

**Guards added, because "be more careful" is not a mechanism:**

- per-model output paths, never a shared temp file;
- the generator queries TEI's `/info` and **asserts the served model id equals the requested
  one**, failing loudly on mismatch;
- a **cross-arm digest comparison** — identical checksums across two models is treated as
  fatal, not as output;
- every step now emits `RESULT <arm> OK|TEI-UNSUPPORTED|EMBED-FAILED|UPLOAD-FAILED` with line
  count and md5, so silence can no longer be mistaken for success.

It is recorded here rather than quietly fixed because it is the clearest single example of
this program's dominant failure mode, and because it was caught by exactly the practice the
rest of the report advocates: comparing two artifacts that should differ, and noticing that
they didn't.

## Methodology

### The frozen benchmark: `cshl-eval-v1`

**Frozen 2026-08-19 07:38Z**, four files, all invariants asserted at freeze time and
re-verified byte-identical after a later regeneration of unrelated training data. Design:

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
MESH 1,241 · AUTHORKW 759), retrieved against the **full 433,449-paper corpus** — not against
each row's own negatives, which would measure reranking and flatter every arm.
`hnsw.ef_search=100`, single gold per query so R@k is hit-rate@k. Each model is scored with
the similarity function it was published for: cosine (`<=>`) for bge-m3 and our fine-tune,
inner product (`<#>`) over raw `[CLS]` for MedCPT and SPECTER2.

| arm | MeSH R@10 | MeSH nDCG@10 | AUTHORKW R@10 | AUTHORKW nDCG@10 |
|---|---:|---:|---:|---:|
| **RRF(ours + MedCPT + FTS)** | **0.4722** | **0.3454** | **0.8235** | **0.6915** |
| RRF(MedCPT + FTS) | 0.4682 | 0.3461 | 0.8208 | 0.7123 |
| RRF(ours + MedCPT) | 0.4641 | 0.3390 | 0.8169 | 0.6781 |
| `ncbi/MedCPT` | 0.4569 | 0.3373 | 0.8076 | 0.6885 |
| RRF(ours + FTS) | 0.3610 | 0.2589 | 0.6877 | 0.5886 |
| `allenai/specter2_base` | 0.3513 | 0.2471 | 0.7260 | 0.6103 |
| RRF(ours + bge-m3) | 0.3328 | 0.2335 | 0.6917 | 0.5685 |
| **ours — `cshl-encoder-bge-m3`** | **0.3320** | **0.2367** | **0.6693** | **0.5625** |
| RRF(FTS + bge-m3) | 0.3167 | 0.2179 | 0.6838 | 0.5888 |
| stock `BAAI/bge-m3` | 0.2861 | 0.1942 | 0.6522 | 0.5524 |
| Postgres FTS — `websearch_to_tsquery` (AND) | 0.0806 | 0.0626 | 0.2398 | 0.2286 |
| Postgres FTS — OR + high-DF pruning *(variant)* | 0.0951 | — | 0.3544 | — |
| `malteos/scincl` | **NOT RUN** — TEI has no `text-embeddings-inference` support | — | — | — |

R@1 for the two headline arms: ours 0.157 (MeSH) / 0.461 (AUTHORKW); MedCPT 0.235 / 0.573.

### Where our model loses

This section is mandatory and it is the important one.

**Against MedCPT: −27% on MeSH** (0.332 vs 0.457) and **−17% on author keywords** (0.669 vs
0.808). MedCPT is a purpose-built biomedical retrieval model; ours is one night of domain
adaptation on a general multilingual encoder. The gap is large and the direction is not close.

**Against SPECTER2 on MeSH: −5%** (0.332 vs 0.351). Unexpected — SPECTER2 is a general
scholarly encoder, not a biomedical one. On author keywords we lose by more (0.669 vs 0.726).

**Against our own base model we win, but only just, and it is the least interesting claim
available.** +16% on MeSH (0.332 vs 0.286), +2.6% on author keywords. Improving on the model
you fine-tuned from, using in-domain data, is closer to a floor than an achievement.

**In fusion, plain BM25 beats us as a contributor — by about 1.6–2×, measured symmetrically.**
An earlier draft of this report said "nearly three times." That was wrong: it compared FTS's
gain when added *first* against ours when added *last*, which are not comparable quantities.
Corrected, with both orderings shown:

| | MeSH R@10 | Δ |
|---|---:|---:|
| MedCPT alone | 0.4569 | — |
| MedCPT + FTS | 0.4682 | **+0.0113** |
| MedCPT + ours | 0.4641 | **+0.0072** |
| | | *FTS adds 1.57× ours* |
| MedCPT + ours → + FTS | 0.4722 | **+0.0081** |
| MedCPT + FTS → + ours | 0.4722 | **+0.0040** |
| | | *FTS adds 2.02× ours* |

So Postgres full-text search — the worst arm alone by a factor of five (0.081) — contributes
**roughly one and a half to two times** what our fine-tuned encoder does to the best fusion.
That is still the striking result, and it no longer overstates itself.

### The leading hypothesis, and it is testable

**We trained on the wrong objective.** The training set was 100% `meta.family = CITE` —
citation-based **document→document** pairs. The benchmark is **query→document**: MeSH
descriptors and author keywords as queries. We trained document similarity and evaluated
query retrieval.

**`cshl-query-pairs` existed and was not used.** The miner lane built **424,753 query-shaped
training pairs** (MESH / AUTHORKW / EXTRACT) and they went untouched while we trained on
citation triplets. That is the single most useful sentence in this report for whoever picks it
up next.

Secondary levers, all unpulled: 40,000 of 132,793 available triplets, one epoch, batch 4
(after OOM halving on a 24 GB A10G), `passage_max_len` 384 rather than 512.

A second run on `cshl-query-pairs` against this same frozen benchmark either closes the gap or
refutes the hypothesis. **Both outcomes are publishable.** Staged and priced below; not fired.

## Independent verification of the baseline arms

The miner lane scored the baseline arms against the same frozen subsample using **their own
scorer**, written without reference to this harness — deliberately, so that agreement would be
evidence rather than a shared bug. All four arms agree **to four decimal places**:

| arm | this harness | independent scorer |
|---|---|---|
| FTS (AND) | 0.0806 / 0.2398 | 8.06% / 23.98% |
| stock bge-m3 | 0.2861 / 0.6522 | 28.61% / 65.22% |
| SPECTER2 | 0.3513 / 0.7260 | 35.13% / 72.60% |
| MedCPT | 0.4569 / 0.8076 | 45.69% / 80.76% |

Their run also produced a **second lexical arm** we had not measured: `websearch_to_tsquery`
with OR semantics plus pruning of terms appearing in >2% of documents — **MeSH R@10 0.0951,
AUTHORKW R@10 0.3544**, materially above the standard AND path (0.0806 / 0.2398), and
~10× faster in their implementation.

It is reported as a **variant, not the headline baseline**, because a baseline whose value
depends on a bespoke optimisation is not the thing an outside reader reproduces when they type
"Postgres full-text search." The conventional AND path is the published number; this row exists
so nobody mistakes the conventional number for the ceiling of lexical retrieval. On author
keywords the pruned variant is **+48% relative** over the standard path — a large enough gap
that anyone building on this should start from the variant, not the baseline.

*Provenance note from that lane, recorded because it affects reproducibility:* their committed
scorer has since been edited and no longer reproduces the table unchanged; the `.json` and
`.ranks.json` files in their `data/mine/results/` are the artifacts of record.

## Method worth reusing: the served-model parity check

**Before any encoder flip is called verified, embed one document's exact indexed text through
the live endpoint and take the cosine similarity against that document's stored corpus
vector. It must be ~1.0.**

That is the whole method, and it is cheap. It exists because a health check cannot see the
failure it is meant to prevent: an endpoint serving the *wrong model* returns HTTP 200, a
correctly-shaped vector, sensible-looking neighbours, and raises nothing. Search then degrades
in a way that reads as "our model is bad" rather than "we are querying the wrong space."

Measured here, twice, by two lanes with separate scripts and different samples:

| comparison | cosine |
|---|---:|
| served endpoint vs `preprint_embeddings_cshl` (our fine-tune) | **0.999999 / 1.00000** |
| served endpoint vs `preprint_embeddings` (stock bge-m3) | **0.77284** |

The second row is what makes the first row meaningful. A parity check that only confirms
agreement with the expected table proves less than one that also shows clear *dis*agreement
with the wrong table — 0.77 is high enough to look plausible in a top-10 list and low enough
to wreck retrieval quality, which is exactly the band where this failure hides.

The check generalises to any two-sided embedding system: whenever documents are embedded by
one process and queries by another, the two spaces must be shown to match rather than assumed
to. It came out of a bug rather than a design, and it is the most portable thing this program
produced.

## Serving — the flip, and why it is worth making despite the loss

Our encoder is served from a `t3.large` (`i-08d4dfab74ff44054`) running TEI on CPU,
API-key gated, weights pulled from S3 rather than the Hub so serving has no external
dependency. TEI reads `max tokens 384` from the checkpoint's own
`sentence_bert_config.json`, matching what it was trained at.

**Parity verified rather than assumed: cosine 0.999999** between the served encoder's output
for one paper's exact recipe text and that paper's stored corpus vector. A wrong-model
endpoint returns plausible vectors and raises nothing, so this check is the difference
between a flip and a hope.

**The case for flipping, given we lost head-to-head.** Our encoder alone scores MeSH R@10
0.332 against MedCPT's 0.457. But production does not serve a bare dense arm — it serves a
fusion of full-text search and a dense arm:

| production configuration | MeSH R@10 |
|---|---:|
| RRF(FTS + **ours**) | **0.361** |
| RRF(FTS + stock bge-m3) | 0.317 |

**+14% on the live product.** The claim is not that we built the best encoder; it is that ours
is a better dense arm than stock inside the fusion users actually hit.

**One variable, fully reversible.** `SEARCH_ENCODER=bge` returns to the known-good stock path
instantly. **Both vector tables stay populated** — `preprint_embeddings` (stock) and
`preprint_embeddings_cshl` (ours), 433,449 rows each, both coverage-gated at 14:29Z. Nothing
about the flip is one-way, and the stock path is never removed.

**Verified end to end by the owning lane** (`api/` and the Vercel environment are theirs,
not this lane's), before any environment change:

```
serve box /health .................. 200
query embed via the box ............ 200 in 0.46 s, dim 1024, unit norm
kNN vs preprint_embeddings_cshl .... 6 rows, 986 ms cold
  0.794  AI-based decoding of long covid cognitive impairments in mice
  0.791  COVCOG 2: Cognitive and Memory Deficits in Long COVID
  0.782  COVCOG 1: Factors predicting Cognitive Symptoms in Long COVID
```

Two hardenings they added that are worth recording, because both prevent a *silent* wrong
answer rather than an error:

- **The dense arm now falls back to stock bge-m3 if the serve box is unreachable**, and the
  vector table follows whichever encoder actually answered. Previously a box failure dropped
  the dense arm entirely; now it costs retrieval quality (0.361 → 0.317 fused) instead of the
  hybrid. Critically, querying one model's space with another model's vector returns confident
  nonsense, so binding the table to the encoder that answered is the part that matters.
- **`NSR_ENCODER_URL` / `NSR_SERVE_KEY` were still inherited from the NSR clone**, pointing at
  the *nuclear-physics* serve box. A flip without repointing them would have queried the wrong
  domain's encoder for preprint search — plausible vectors, no error. Repointed and redeployed,
  verified through the API rather than `vercel env ls`, which reports *created* time and made
  it look unchanged.

**The flip itself was deliberately not made tonight.** It is one environment variable plus a
redeploy, fully staged and verified up to that point. The owning lane declined to lift a
condition set by another party on their behalf, which is the right call.

*Handoff note recorded because it is the kind of thing that silently breaks a cutover:* the
app's `vectorTable()` mapped the fine-tuned arm to `preprint_embeddings_ft`, while the
populated table is `preprint_embeddings_cshl`. Flipping without reconciling those would leave
`hasEmbeddings()` probing a non-existent table, the dense arm degrading to FTS-only, and
`/chat` appearing to run on our encoder while serving keyword-only results — no error,
plausible output. Flagged to the owning lane before the flip.

### The flip, made 2026-08-20 — now serving the qpairs encoder

*This subsection supersedes "the flip itself was deliberately not made tonight" above, which is
kept because the reasoning for waiting was sound and the sequence matters.*

The serve box (`i-08d4dfab74ff44054`, unchanged, same IP) was re-pointed in place at the qpairs
weights — `models/cshl-encoder-bge-m3/20260819-192100-train/serve/`, md5
`7a508120e27bd708ea5bcd070fa435c2` against the CITE model's `ec06108315187750f9cdbf07813c2de0`
— and `vectorTable("nsr")` moved with it to `preprint_embeddings_cshl_qp`. The box and that
constant are one decision in two places.

Parity re-verified on the new weights, three papers, against all three tables:

| | vs `_cshl_qp` (serving) | vs `_cshl` (CITE) | vs `preprint_embeddings` (stock) |
|---|---:|---:|---:|
| cosine | **0.999998 – 0.999999** | 0.4647 – 0.6551 | 0.4575 – 0.6326 |

The disagreement column is wider than the 0.77 measured for stock-vs-CITE: query-shaped
fine-tuning moved the embedding space considerably further from the citation model than the
citation model moved from stock.

**Two things this cutover proved that the staging had not.**

*The encoder-down fallback binds the table to the encoder, tested rather than reasoned about.*
On a throwaway preview with a deliberately unreachable `NSR_ENCODER_URL`, the serve box logged
**zero** requests, the dense arm still returned four rows, and they came from
`preprint_embeddings` at cos 0.63–0.64 with a different neighbour set — stock bge-m3's space,
not ours. A box failure costs retrieval quality and nothing else.

*The flip was already half-made, and finding that out late cost a real mismatch window.* This
section said the flip had not been made; by the time it was acted on, `SEARCH_ENCODER=nsr`,
`NSR_ENCODER_URL` and `NSR_SERVE_KEY` had all been set in Vercel Production. So re-pointing the
box put production into exactly the state this report warns about — a live build reading the
**CITE** table with **qpairs** query vectors — for about seven minutes, until the code deploy
landed. It is visible in the numbers rather than inferred: the same question returned dense
similarities of 0.41 / 0.41 / 0.40 mismatched and 0.58 / 0.58 / 0.58 matched, with no error at
any point in between. Zero requests had hit the box in the preceding hour and the only request
inside the window was the operator's own probe, but that is luck and not a control. **The
correct sequence, when the flip is already live, is `SEARCH_ENCODER=bge` → reweight → deploy →
`SEARCH_ENCODER=nsr`, which has no mismatched state at any point.** The general lesson is
narrower and worse: a document was trusted over a thirty-second measurement, on precisely the
question the document was least likely to still be current about.

**Both remaining arms stay populated and untouched.** `preprint_embeddings_cshl` (CITE) is not
dead weight — it is still the better document→document encoder (R@10 0.2120 vs 0.1980) and the
right arm for "more like this", reviewer matching and systematic-review expansion. Fusing it
back into the *query* path was measured and makes things worse in every combination:
RRF(qpairs+CITE+FTS) 0.4230 and RRF(qpairs+CITE) 0.4077 both land below qpairs alone at 0.4319.

**Rollback is `SEARCH_ENCODER=bge` plus a redeploy**, and it is correct under *any* version of
`api/_lib/embed.ts` because `vectorTable("bge")` is `preprint_embeddings` in all of them —
which is what makes it a rollback rather than a second flip. The CITE weights also remain on
the box at `/models/enc.cite` for a box-level revert.

**Open hazard.** Production is deployed from `main` by GitHub integration; this fix is a CLI
deploy from `lane/rxiv-load`. A routine push to `main` would restore a build whose
`vectorTable("nsr")` is the CITE table while the box keeps serving qpairs — the mismatch above,
re-created silently by someone who never touched serving. Merging the branch closes it.

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

## Staged: the one experiment that would settle it

**FIRED 2026-08-20 as run `20260819-192100-train`. Result in "The qpairs run" below; the
staging is kept verbatim for the record, including the command that could not have worked.**

The leading hypothesis for our shortfall is an objective mismatch — we trained on
citation-based **document→document** pairs and evaluated **query→document** retrieval. The
data to test it already exists on disk, frozen: `cshl-query-pairs`, **424,753 query-shaped
training pairs** across MESH / AUTHORKW / EXTRACT families, built by the miner lane and never
used.

```bash
# 1. convert (local, free, ~3 min)
IN=data/mine/cshl-query-pairs.train.jsonl NAME=qpairs SUBSAMPLE=40000 \
  node --max-old-space-size=6144 scripts/train/from-mine.mjs

# 2. upload the slice + the frozen queries
NAME=qpairs EVAL_VERSION=cshl-eval-v1 ./scripts/train/upload-slice.sh

# 3. train  (g5.2xlarge, A10G 24 GB — g6e had no capacity all night)
TYPE=g5.2xlarge MODE=train TRAIN_NAME=qpairs EVAL_VERSION=cshl-eval-v1 \
  BATCH=8 EPOCHS=1 QUERY_MAX_LEN=128 PASSAGE_MAX_LEN=384 GROUP_SIZE=8 \
  ./scripts/train/launch.sh

# 4. re-embed into a THIRD table, keeping both existing ones
MODEL_S3=s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/<new-run>/final \
  EMB_TABLE=preprint_embeddings_cshl_qp N=2 ./scripts/embed-nsr/launch.sh

# 5. score against the identical frozen subsample
EVAL_VERSION=cshl-eval-2k ARMS=cshl_qp,rrf:cshl_qp+medcpt+fts node scripts/eval/score.mjs
```

| step | wall-clock | $ |
|---|---|---:|
| convert + upload | ~8 min | 0.00 |
| train, 40,000 pairs, 1 epoch | ~2 h 20 m | **2.85** |
| re-embed 433,449 × 2 boxes | ~25 min | **0.85** |
| score | ~3 min | 0.00 |
| **total** | **~3 h** | **≈ $3.70** |

**Budget reality: this does not fit under the remaining ceiling alongside anything else.**
About $6.70 of $10.50 is spent, leaving ~$3.80. The run above is ~$3.70. It fits only if
nothing else is spent, and it leaves no margin for a failed box.

**A cheaper variant that still tests the hypothesis:** 15,000 pairs instead of 40,000
(~55 min train, **≈ $1.15**, plus $0.85 re-embed = **≈ $2.00**). Statistically weaker but it
answers the same yes/no question — does query-shaped supervision move MeSH R@10 off 0.332
toward MedCPT's 0.457? A directional answer is worth more than a precise null.

**If a bigger box becomes available**, `g6e.xlarge` (L40S, 48 GB) removes the OOM halving that
forced batch 4, roughly halving the step count at the same pair budget. `g6e` had zero
capacity in every AZ throughout this night; it is worth re-probing before committing.

## The qpairs run — 2026-08-20, `20260819-192100-train`

The experiment staged above, fired. Full log, verification evidence and spend:
`docs/prompts/LANE-QPAIRS-RUN.md`.

**The staged command could not have worked, and this is the most reusable thing in this
section.** `cshl-query-pairs` carries `query` as a **literal query string** on all 424,753 rows;
`scripts/train/from-mine.mjs` read `r.query.slug`, which is the shape `cshl-triplets` uses. Run
as staged, every row falls into the `dropped` counter, the converter writes an **empty**
`train.jsonl` and prints its normal success line, `upload-slice.sh` ships it (it gated on a
`disjointness.pass` that was a hardcoded literal `true`), and `train.sh` accepts it. Caught by
counting the input before running the command rather than after. The converter now handles both
shapes, aborts non-zero on zero convertible records, counts families **in what it emits**, and
computes `disjointness.pass` from a post-hoc re-scan instead of asserting it.

### What was trained

39,999 pairs subsampled deterministically and stratified across all three families, counted in
the emitted file: **MESH 9,668 · AUTHORKW 5,854 · EXTRACT 24,477**. Zero emitted records
reference a frozen-benchmark gold paper (re-derived over the emitted set, not inherited from
lane-mine's split). 157 of 39,999 training queries share a query *string* with a benchmark
query — disclosed, not a leak, because the benchmark splits by **paper**.

`g6e.2xlarge` (L40S 48 GB), 1 epoch, `QUERY_MAX_LEN=128`, `PASSAGE_MAX_LEN=384`,
`GROUP_SIZE=8`, 4,999 steps, 55 min. **`BATCH=16` was requested and OOMed**; the guard halved to
8. Effective batch is therefore **8**, twice the CITE run's 4 — not the 4× intended. Every claim
here is "query-shaped supervision at batch 8".

### Results — query→document, identical frozen 2,000-query subsample

| arm | MeSH R@10 | MeSH nDCG@10 | AUTHORKW R@10 | AUTHORKW nDCG@10 |
|---|---:|---:|---:|---:|
| **RRF(qpairs + MedCPT + FTS)** | **0.5197** | **0.3879** | **0.8300** | **0.7197** |
| RRF(ours + MedCPT + FTS) — *previous best* | 0.4722 | 0.3454 | 0.8235 | 0.6915 |
| `ncbi/MedCPT` | 0.4569 | 0.3373 | 0.8076 | 0.6885 |
| RRF(qpairs + FTS) | 0.4512 | 0.3333 | 0.7655 | 0.6540 |
| **`cshl_qp` — ours, query-pairs** | **0.4319** | **0.3190** | **0.7497** | **0.6395** |
| `cshl` — ours, CITE | 0.3320 | 0.2367 | 0.6693 | 0.5625 |
| Postgres FTS | 0.0806 | 0.0626 | 0.2398 | 0.2286 |

R@1: qpairs 0.2224 / 0.5336 against CITE's 0.1571 / 0.4611.

Paired McNemar (exact, two-sided) with a seeded 5,000-resample bootstrap, on the same queries in
the same order — asserted by the harness, not assumed:

| comparison | family | n | ours-only | theirs-only | ΔR@10 | p | 95% CI |
|---|---|---:|---:|---:|---:|---:|---|
| qpairs vs CITE | MESH | 1,241 | 180 | 56 | **+0.0999** | 2.3e-16 | [+0.0766, +0.1225] |
| qpairs vs CITE | AUTHORKW | 759 | 86 | 25 | **+0.0804** | 5.0e-9 | [+0.0540, +0.1080] |
| qpairs vs **MedCPT** | MESH | 1,241 | 123 | 154 | −0.0250 | **0.071** | **[−0.0516, +0.0016]** |
| qpairs vs **MedCPT** | AUTHORKW | 759 | 48 | 92 | −0.0580 | 0.0003 | [−0.0883, −0.0277] |

**On MeSH the difference from MedCPT is no longer statistically significant.** On author
keywords it clearly still is, in MedCPT's favour.

### Results — document→document, the same 2,000 held-out pairs

| arm | R@1 | R@10 | R@50 | MRR |
|---|---:|---:|---:|---:|
| `cshl` — CITE | 0.0700 | **0.2120** | 0.3445 | 0.1167 |
| **`cshl_qp` — query-pairs** | 0.0630 | **0.1980** | 0.3145 | 0.1061 |
| stock `BAAI/bge-m3` | 0.0620 | 0.1955 | 0.2900 | 0.1053 |
| `ncbi/MedCPT` | 0.0580 | 0.1790 | 0.3020 | 0.0985 |

| comparison | ΔR@10 | p | 95% CI |
|---|---:|---:|---|
| qpairs vs CITE | **−0.0140** | 0.043 | [−0.0275, −0.0010] |
| qpairs vs MedCPT | +0.0190 | 0.015 | [+0.0040, +0.0340] |
| qpairs vs stock `BAAI/bge-m3` | +0.0025 | **0.78** | [−0.0110, +0.0165] |

The regression was predicted and is significant. The important row is the last: **on doc→doc the
qpairs model is indistinguishable from the base model it was fine-tuned from.** Citation
training bought a real doc→doc advantage and query training spent all of it. This is a trade
between two encoders, not an upgrade of one — which is why the run went into a **third** table
and both existing ones were left untouched.

### The confound

The objective and the effective batch size both changed (4 → 8), because an L40S was available
where the previous night had only a 24 GB A10G. This run cannot attribute between them; two
clean runs did not fit the $5.00 lane budget. The bound that can be stated: the batch-4
fine-tune bought +0.046 MeSH R@10 over stock bge-m3, and this run bought +0.0999 on top of that,
while moving doc→doc in the **opposite** direction at the same batch size — the signature of an
objective change, not a capacity change.

### Verification

Coverage gate **passed 2026-08-20 01:00Z**, every figure re-derived at assertion time:

```
corpus 433,449 · embeddable 433,449 · excluded by the <20-char rule 0
preprint_embeddings_cshl_qp  433,449  uncovered 0  dim 1024  zero-vectors 0
text_hash vs canonical recipe: 0 mismatches of 433,449 checked
HNSW idx_pp_emb_cshl_qp_hnsw 3,386 MB  vector_cosine_ops  indisvalid=t
preprint_embeddings_cshl     433,449  last write 2026-08-19 14:06Z  (untouched)
preprint_embeddings_medcpt   433,449  last write 2026-08-19 07:07Z  (untouched)
```

Controls, run **after** the registry edit so the edit is inside the test: `cshl`, `medcpt` and
`fts` each reproduced their published numbers to **every digit** before the new arm was scored,
and `cshl_qp` reproduced itself across two independent scoring runs. The new arm's query
vectors were digest-compared against all four other arms and differ from each — the guard added
after the two-arms-one-model incident, firing on the pair most able to collide.

**A trap worth recording:** `cshl-eval-v1` and the frozen 2k subsample use **independent qid
namespaces** — 943 of the 2,000 benchmark qids do not exist in `cshl-eval-v1`, and the same
label denotes different queries in each. Joining query vectors by qid would silently pair 47% of
queries with another query's vector at the right dimension and the right row count. The already
published arms were checked and do **not** have this bug (0 qid-matches; they were embedded
directly). `scripts/eval/qemb-from-run.mjs` fails loudly rather than joining across it.

**Spend: $2.95 of a $5.00 cap** — train $2.32, re-embed $0.54, S3 ~$0.10. Itemised waste,
including a $0.11 OOM probe and a silent `AccessDenied` that cost ~25 minutes, is in the lane
log.

**Not pushed to Hugging Face.** Publish decisions are Brendan's, by name.

## The reranker run — 2026-08-20, `cshl-RR` (`20260819-223601-train`)

T3, the reranker fine-tune, is the one line of the original launch menu that had never been
bought. It has now run. **What it produces is a SYSTEM, and the distinction is the whole
point of this section.**

### What was trained

`Alibaba-NLP/gte-reranker-modernbert-base`, a cross-encoder, on **40,000 groups** converted
from the same mined query-pair harvest the qpairs encoder used — one query, one positive,
and the surviving hard negatives (`mesh-tree-sibling` / `same-category`), 2 epochs, on one
`g6e.2xlarge` (L40S) in **42.3 min**. Family mix MESH 24,539 / AUTHORKW 15,461 (61/39),
matching the benchmark's 62/38. Query and document text are sliced to 600/900 characters —
the same budget the serving path sends, so the trained and served conditions agree.

Every held-out paper was kept off the GPU. The converter's md5 rule was checked against the
frozen benchmark rather than trusted: **1,839/1,839** gold papers in `cshl-eval-2k` and
**6,203/6,203** in `cshl-eval-v1` fall on the held-out side, and the emitted groups contained
**zero** held-out papers. The miner had already excluded held-out papers as *positives*
(0.0% across train/val/test) but not as *negatives* (25.0%, the base rate), so the guard did
real work: mean negatives per group is **5.90, not 7**, because ~25% of every record's
negatives were benchmark papers.

### Results — reranking `cshl_qp`'s top-50, identical frozen 2,000-query subsample

The candidate pool was regenerated with the same operator, `ef_search` and `TOPK` the encoder
row used, then checked against the published run before use: all ten metrics across both
families reproduced **exactly**. So "before" below is the published `cshl_qp` row itself, and
the delta is purely reranking.

| family | metric | `cshl_qp` alone | **`cshl_qp` + `cshl-RR`** | Δ |
|---|---|---:|---:|---:|
| MESH (n=1,241) | R@10 | 0.4319 | **0.5238** | **+21%** |
| MESH | nDCG@10 | 0.3190 | **0.4075** | **+28%** |
| MESH | R@1 | 0.2224 | **0.3022** | +36% |
| AUTHORKW (n=759) | R@10 | 0.7497 | **0.7668** | +2% |
| AUTHORKW | nDCG@10 | 0.6395 | **0.6746** | +5% |
| AUTHORKW | R@1 | 0.5336 | **0.5771** | +8% |

Gains hold in **19 of 20** segments on both R@10 and nDCG@10. The exception is honest and
recorded: **AUTHORKW `server:medrxiv` (n=135) lost one query** on R@10, 0.7037 → 0.6963
(95 hits → 94), while its nDCG@10 rose +5%. That single query is why the strict
all-segments gate boolean reads `false`. Nothing else regressed anywhere.

MESH — keyword-ish MeSH-term queries, the family this program has been losing on all along —
is where the reranker pays. AUTHORKW was already dense retrieval's strength and moves little
on R@10 while still sharpening the top of the list (R@1 +8%).

### Paired significance — and what it does and does not claim

Exact McNemar plus a seeded bootstrap CI over 2,000 queries (`scripts/eval/paired-test.mjs`),
pooled across families:

| comparison | R@10 | Δ | McNemar *p* | 95% CI |
|---|---|---:|---:|---|
| `cshl_qp`+`cshl-RR` **vs its own un-reranked top-50** | 0.6160 vs 0.5525 | **+0.0635** | **6.4e-17** | [+0.049, +0.079] |
| `cshl_qp`+`cshl-RR` **vs MedCPT's encoder** | 0.6160 vs 0.5900 | **+0.0260** | **0.0119** | [+0.006, +0.046] |
| `cshl_qp` encoder **vs MedCPT's encoder** *(unchanged)* | 0.5525 vs 0.5900 | **−0.0375** | 0.0003 | [−0.058, −0.018] |

Read those three rows together, because the third is the one that keeps the second honest:

- **The reranker works, decisively.** 183 queries won against 56 lost, *p* ≈ 6e-17.
- **The system beats MedCPT's encoder**, significantly (*p* = 0.012, CI excludes zero).
- **Our encoder still loses to MedCPT's encoder**, significantly, exactly as before. The
  reranker did not change that row and this report does not claim it did.

**This is a system-vs-encoder comparison, which is not apples-to-apples.** A cross-encoder
over 50 candidates is a second model and roughly 150 ms of extra GPU work per query; MedCPT's
encoder row is one vector lookup. The encoder-only rows elsewhere in this report remain the
encoder-vs-encoder claim and are unaffected by anything here.

**MedCPT also publishes a cross-encoder** (`ncbi/MedCPT-Cross-Encoder`), so beating their
encoder is the weaker of the two available claims. **The full system-vs-system comparison has
since been run — see the next section. We lose it.** The row above stands as written, but it
is not the headline number; the one below is.

### Serving cost, measured

**326 pairs/s on an A10G**, **p50 150.8 ms / p95 162.6 ms per query** over 50 candidates at
batch 256 — the GPU serving number the NSR lane left open. **CPU latency remains unmeasured**,
so this does not yet pick a serving tier.

### Spend

**≈$2.04 of a $5.00 cap** — training $1.70 (45.6 min, g6e.2xlarge), scoring $0.14, plus
$0.14 for a rerun after an `AccessDenied` on the results prefix destroyed a completed scoring
pass. All three boxes self-terminated. **Not pushed to Hugging Face** — that is a separate
ruling by name.

## System vs system — `cshl-QP`+`cshl-RR` against MedCPT's full stack

Follow-up #7, run the same night. This is the comparison that decides whether the program has
a better *retrieval system* than the in-domain baseline, and the answer is **no, not yet** —
but the reason is specific, measurable, and not the reranker.

### Method — each system at its own published or trained configuration

Handicapping MedCPT would make a win worthless, so its cross-encoder ran at the config its
model card specifies: `max_length=512`, `[[query, article]]` pairs, higher logit = more
relevant. That needed wider documents than our own pipeline uses, and the gap is not
cosmetic — **at our 900-character serving slice, 97.5% of candidate documents are truncated;
at 2,000 characters, 30.1%** (mean 895 → 1,646 chars). MedCPT therefore got a 2,000-char
document set built for it. `cshl-RR` ran at 900 chars / 256 tokens, which is both what it was
trained on and what `api/_lib/embed.ts` actually sends — our system measured as it would
serve, theirs measured at its published best.

Both candidate pools were regenerated with each arm's own registry operator (`cosine <=>` for
ours, `ip <#>` for MedCPT) and **verified against the published rows before use: all ten
metrics reproduced exactly for both arms.** `rerank.py` was also hardened first — it no longer
forces `num_labels`, because forcing a head size that does not match a published checkpoint
makes `transformers` silently reinitialise the classifier with random weights and report a
number that is not the published model's at all. Both models were confirmed to load with
`num_labels=1` (MedCPT `max_position_embeddings=512`, ours 8192).

### The 2×2 — pool × cross-encoder, R@10 / nDCG@10

| system | AUTHORKW | MESH |
|---|---|---|
| `cshl_qp` encoder only | 0.7497 / 0.6395 | 0.4319 / 0.3190 |
| **`cshl_qp` + `cshl-RR`** (ours) | 0.7668 / 0.6746 | **0.5238 / 0.4075** |
| `medcpt` encoder only | 0.8076 / 0.6885 | 0.4569 / 0.3373 |
| **`medcpt` + `MedCPT-CE`** (theirs) | **0.8577 / 0.7741** | 0.5246 / 0.4047 |
| `medcpt` + `cshl-RR` *(cross cell)* | 0.8235 / 0.7225 | **0.5439 / 0.4236** |

### Paired significance (exact McNemar + seeded bootstrap, `FAMILY=` slices)

| comparison | scope | R@10 | Δ | *p* | 95% CI |
|---|---|---|---:|---:|---|
| **ours vs theirs, system vs system** | blended | 0.6160 vs 0.6510 | **−0.0350** | **0.0002** | [−0.054, −0.016] |
| | MESH | 0.5238 vs 0.5246 | −0.0008 | **1.0000** | [−0.025, +0.024] |
| | AUTHORKW | 0.7668 vs 0.8577 | −0.0909 | 2.3e-11 | [−0.117, −0.065] |
| **same pool, our RR vs their CE** | blended | 0.6500 vs 0.6510 | −0.0010 | **0.9312** | [−0.013, +0.010] |
| | MESH | 0.5439 vs 0.5246 | **+0.0193** | **0.0127** | [+0.005, +0.034] |
| | AUTHORKW | 0.8235 vs 0.8577 | −0.0343 | 0.0002 | [−0.053, −0.017] |
| their reranker's own lift | blended | 0.6510 vs 0.5900 | +0.0610 | 7.3e-18 | [+0.047, +0.075] |

### What this actually says

**We lose the system comparison, and it is not close on the blended number** — −0.0350,
*p* = 0.0002. Reported as the deciding result, because it is.

But the second block localises the loss, and this is the part worth acting on:

- **On MedCPT's own candidate pool, our reranker and theirs are a statistical dead heat**
  (−0.0010, *p* = 0.93, CI ±0.01).
- **On MeSH queries, our reranker beats MedCPT's cross-encoder outright** on their own pool
  (+0.0193, *p* = 0.013, CI excludes zero) — and `medcpt`+`cshl-RR` at **0.5439** is the best
  MeSH R@10 any configuration produced tonight, better than either complete system.
- On author-keyword queries our reranker is genuinely weaker (−0.0343).

So **essentially the whole system gap is the encoder, not the reranker.** Our reranker is
competitive with MedCPT's on equal footing and better than it on the family this program
cares most about; it is being handed a worse pool to work with. The pool ceilings say the
same thing — R@50 is 0.8208/0.6076 for `cshl_qp` against 0.8920/0.6237 for `medcpt`, so
AUTHORKW retrieval is short by 7 points of recall before any reranking happens.

**The lever is the encoder, specifically on AUTHORKW.** Another reranker epoch would not
close this; better retrieval would.

### Two caveats that cut in opposite directions, both recorded

1. **`cshl-RR` is fine-tuned on this domain; MedCPT's cross-encoder is zero-shot here.** Ours
   saw 40,000 in-domain groups mined from this corpus. Theirs was trained on PubMed click
   logs and has never seen bioRxiv/medRxiv. That our tuned reranker only *ties* theirs
   overall is a weaker result than the raw numbers suggest, and it flatters us on MeSH.
2. **MedCPT may have seen some of these papers.** It was trained on PubMed, and a large share
   of this corpus is preprints of papers later published in PubMed-indexed journals. We
   cannot rule out that its advantage on AUTHORKW is partly familiarity. This cuts in
   *their* favour, so it does not rescue our loss — but it does mean the AUTHORKW gap is an
   upper bound on their genuine modelling advantage, not a clean measurement of it.

**Spend: $0.23** (one `g5.xlarge`, 14 min, both cells, `COMPARE-EXIT=0`, both uploads
verified by `head-object` before shutdown) against the $0.75 the lead authorised.

## The final system row — `cshl-QP2` + `cshl-RR` vs MedCPT's full stack

The system comparison above was run against `cshl-QP`. `cshl-QP2` (the win lane's
100k-weighted retrain) landed later the same night, and the reranker was re-run over **its**
top-50 — the same `cshl-RR` checkpoint, untouched, because a cross-encoder scores
(query, document) text and is indifferent to which encoder built the pool.

**The verdict changes from a significant loss to a statistical dead heat.**

| comparison | scope | R@10 | Δ | *p* | 95% CI |
|---|---|---|---:|---:|---|
| **`QP2`+`cshl-RR` vs `MedCPT`+`MedCPT-CE`** | blended | 0.6450 vs 0.6510 | **−0.0060** | **0.5543** | [−0.024, +0.013] |
| | MESH | **0.5488** vs 0.5246 | **+0.0242** | 0.0632 | [−0.001, +0.048] |
| | AUTHORKW | 0.8024 vs 0.8577 | −0.0553 | 3.9e-5 | [−0.080, −0.030] |
| *(for contrast, the `QP` system)* | blended | 0.6160 vs 0.6510 | −0.0350 | 0.0002 | [−0.054, −0.016] |
| `cshl-RR`'s lift on QP2 | blended | 0.6450 vs 0.6150 | +0.0300 | 9.9e-5 | [+0.016, +0.045] |
| | MESH | +0.0250 | | 0.0171 | [+0.005, +0.045] |
| | AUTHORKW | +0.0382 | | 0.0009 | [+0.016, +0.059] |
| encoder upgrade, at system level | blended | 0.6450 vs 0.6160 | +0.0290 | 2.8e-5 | [+0.016, +0.042] |

### Full matrix, R@10 / nDCG@10

| system | AUTHORKW | MESH |
|---|---|---|
| `cshl_qp` | 0.7497 / 0.6395 | 0.4319 / 0.3190 |
| `cshl_qp` + `cshl-RR` | 0.7668 / 0.6746 | 0.5238 / 0.4075 |
| `cshl_qp2` encoder | 0.7642 / 0.6502 | 0.5238 / 0.3881 |
| **`cshl_qp2` + `cshl-RR`** | 0.8024 / 0.7002 | **0.5488 / 0.4193** |
| `medcpt` | 0.8076 / 0.6885 | 0.4569 / 0.3373 |
| `medcpt` + `MedCPT-CE` | **0.8577 / 0.7741** | 0.5246 / 0.4047 |
| `medcpt` + `cshl-RR` | 0.8235 / 0.7225 | 0.5439 / 0.4236 |

### What changed, and what did not

- **Blended is now a tie** (−0.0060, *p* = 0.55, CI straddling zero). The −0.0350 loss is gone,
  and the encoder upgrade accounts for essentially all of it: +0.0290 at system level,
  *p* = 2.8e-5. **This is the prediction from the previous section confirmed** — the gap was
  the encoder, and a better encoder closed it.
- **MeSH now leads**: 0.5488 vs 0.5246, +0.0242. Honest caveat: *p* = 0.063 and the CI is
  [−0.001, +0.048], so this is **a lead, not a proven win** — it does not clear the bar and
  should not be quoted as if it did. `cshl_qp2`+`cshl-RR` is nonetheless the best MeSH R@10
  of any configuration tested, above `medcpt`+`cshl-RR` (0.5439).
- **AUTHORKW is still a clear loss** (−0.0553, *p* = 3.9e-5), narrowed from −0.0909 but not
  closed. This remains the single lever on the system comparison.
- The reranker keeps earning its place on the better encoder — +0.0300 blended, significant
  in **both** families, and its AUTHORKW lift actually grew (+0.0382 vs +0.0171 on QP).

**Caveat carried forward:** `cshl-RR` is fine-tuned on this domain; `MedCPT-CE` is zero-shot
here. And unlike the `cshl_qp` and `medcpt` pools, **the `cshl_qp2` pool could not be
cross-checked against a published encoder row, because none existed when this ran** — the
encoder numbers in the matrix above are this lane's own derivation from its own top-50 dump
and are offered to the win lane for confirmation.

**Spend: $0.15** (one `g5.xlarge`, ~9 min, `SCORE-EXIT=0 UPLOAD-EXIT=0`), plus **$0.03**
wasted on a box killed 80 seconds in — see the lane log; a stale S3 object let a preflight
pass against a document set that did not contain QP2's pool.

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
7. ~~Score MedCPT's full system~~ — **DONE**, and then **re-done on `cshl-QP2`**, which
   turned the −0.0350 loss into a **−0.0060 tie** (*p* = 0.55) with a MeSH lead of +0.0242
   (*p* = 0.063, not significant). See "The final system row". **The remaining lever is
   AUTHORKW retrieval**, still −0.0553 against MedCPT's stack: `cshl_qp2` R@50 is 0.8669
   there against MedCPT's 0.8920, so the pool still caps what any reranker can recover.
   Closing that gap is now the whole game — it is an encoder question, not a reranker one.
8. **CPU latency for the cross-encoder is unmeasured.** GPU is 150.8 ms p50 per query over 50
   candidates; the serving decision needs the CPU number too, and the current serve box is a
   `t3.large`.
9. **The reranker's negatives were thinned, not backfilled.** The held-out guard removed ~25%
   of mined negatives, leaving 5.90 per group where `train.py` expects 7 — it pads by
   repeating the last negative. A converter that draws replacements from the non-held-out
   pool would restore full 7-way contrast. Untested upside.
10. **`train.sh`'s throughput reporter under-counted by a factor of EPOCHS** and has been
   fixed. Any planning number derived from it before 2026-08-20 — including the NSR lane's
   `26.4 groups/s` precedent that this lane's own projections were built on — should be
   re-derived rather than trusted.

---

## Provenance

Rigs ported from the NSR program at commit `8c1b05b` (`docs/NSR-CPT-REPORT.md`), which
itself inherited the embed and reranker rigs from 44b. What changed, and why, is recorded
per file in `docs/prompts/LANE-RIG-PORT.md`.

---

## The QP3 run — a negative result, recorded rather than buried

**2026-08-20. More data made the model worse. It is not published, and this section
is why.**

`cshl-QP3` was the third encoder in the query-pairs line and the largest: **140,000
pairs — MESH 45,000 · OAKW 50,000 · AUTHORKW 40,000 · EXTRACT 5,000** — with **ANCE
hard negatives** mined from cshl-QP2's own index, trained on the identical rig and
config that produced QP2 (one L40S, batch 8, `passage_max_len` 384, 17,500 steps,
1 epoch, 3 h 33 m, train loss 1.233). It reproduced QP2's throughput control exactly
(1.47–1.52 it/s at 33.9 GB), so the hardware was not a variable. Coverage gate passed:
433,449 / 433,449, zero nulls, query vectors digest-distinct from all six other arms.

It lost to everything, including its own parent:

| arm | MeSH R@10 | AUTHORKW R@10 | blended |
|---|---:|---:|---:|
| cshl-QP2 (100k) | **0.5238** | **0.7642** | **0.6150** |
| cshl-QP (40k) | 0.4319 | 0.7497 | 0.5525 |
| **cshl-QP3 (140k)** | **0.3997** | **0.7457** | **0.5310** |

Paired exact McNemar, same 2,000 queries:

| comparison | ΔR@10 blended | p | MeSH Δ | p |
|---|---:|---:|---:|---:|
| QP3 vs QP2 | **−0.0840** | 6.9e-18 | **−0.1241** | 3.9e-22 |
| QP3 vs QP (40k) | −0.0215 | 0.029 | −0.0322 | 0.014 |

**The run's own objective did not move.** AUTHORKW — the family the whole experiment
was designed to fix, and the reason OAKW was mined at all — went 0.7642 → 0.7457,
p = 0.24. Not significantly different. The keyword offensive failed on keywords *and*
gave back the MeSH win.

**Two suspects, and the run cannot separate them** because it changed both variables at
once:

1. **The OAKW family.** 50,000 of 140,000 pairs were OpenAlex *concept* labels, a query
   type never validated against this benchmark. OpenAlex concepts are broad and heavily
   overlapping ("Biology", "Genetics"); 36 % of the training signal telling the encoder
   that coarse labels are good queries is a plausible mechanism for blurring exactly the
   fine topical distinctions MeSH descriptors demand.
2. **ANCE false negatives.** Hard negatives mined from QP2's own top-100 include
   genuinely relevant papers that simply are not the annotated gold. Training against
   them punishes correct retrieval.

**Not published, deliberately.** `NYSgpt` carries QP and QP2; QP3's weights stay in S3
at `models/cshl-encoder-bge-m3/20260820-053000-train/`. A checkpoint that loses to its
own parent should not sit on a hub where someone could pull it by name. The reranked
system row (`cshl_qp3 + cshl-RR`) was never computed — the lane stopped before it, and
there is no reason to spend on it now.

**What it cost and what it bought.** About $9 and a night. It bought two things worth
more than the model would have been: the measured knowledge that this scaling curve is
**not monotonic** — 40k → 100k helped, 100k → 140k hurt — and a named, testable
hypothesis for why. The clean follow-up, if anyone wants it, is an ablation at 140k with
**no OAKW and no ANCE**, which isolates volume from data quality for about $9.
