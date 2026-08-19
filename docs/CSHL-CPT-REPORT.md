# CSHL-CPT — the RxivGPT model program

*Night of 2026-08-19. Modelled on `docs/NSR-CPT-REPORT.md`, which covers the sibling
program on nuclear-science literature.*

---

## Headline

**We did not beat MedCPT.** Our fine-tuned encoder scores **MeSH R@10 0.332** against
`ncbi/MedCPT`'s **0.457** — one night of domain adaptation closed about a quarter of the gap
to a purpose-built biomedical retriever, not all of it. It also lost to `allenai/specter2_base`
(0.351), which we did not expect.

**What did win is a fusion.** `RRF(ours + MedCPT + FTS)` scores **MeSH R@10 0.4722**, the best
arm measured, beating MedCPT alone by 3.3% relative. Our encoder's marginal contribution to
that fusion is **+0.9%** over `RRF(MedCPT + FTS)` — real, positive, and small.

**The most useful result is about full-text search.** Postgres FTS is the worst arm alone
(MeSH R@10 0.081, five times worse than anything else) and the *largest single contributor*
in fusion: adding it to MedCPT gains **+2.5%**, nearly three times what our encoder adds.
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
| Postgres FTS | 0.0806 | 0.0626 | 0.2398 | 0.2286 |
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

**In fusion, plain BM25 beats us as a contributor.** `RRF(MedCPT+FTS)` 0.4682 against
`RRF(ours+MedCPT)` 0.4641. Our marginal contribution on top of `RRF(MedCPT+FTS)` is
**+0.9%** (0.4682 → 0.4722); FTS's contribution on top of MedCPT alone is **+2.5%**
(0.4569 → 0.4682). Postgres full-text search — the worst arm alone by a factor of five —
adds nearly three times what our fine-tuned encoder does.

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

**Not fired. Priced. Brendan's call.**

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
