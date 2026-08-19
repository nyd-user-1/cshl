# Rig doctrine — portable lessons for GPU work (NSR · CSHL · 44b · Leuk)

Written 2026-08-19 after the CSHL overnight. These are the things that cost us time or
quality, stated so the next project does not rediscover them.

## 0. The governing rule: time first, cost second, always priced together

Before any long-running job, ask **"what does it cost to make this finish sooner?"** and put a
number on it. Not as an afterthought — as part of speccing the job. A 2.3-hour train that
could be a 35-minute train for a few extra dollars is almost always worth the dollars, because
wall-clock is the scarce resource and idle humans/agents waiting on a rig are the real expense.

The question is never "how long will it take." It is **"how long, at what price, and what is
the next cheaper rung?"** For some jobs cost wins. You cannot know which without pricing both.

## 1. Batch size is a QUALITY parameter in contrastive training, not just a speed knob

This is the most expensive thing we learned, and we learned it after the fact.

Embedding fine-tunes (bge-m3, SPECTER-style, anything contrastive) learn from **in-batch
negatives**: every other example in the batch acts as a negative for each query. So

    batch 4   → ~3 negatives per example
    batch 16  → ~15
    batch 64  → ~63

More negatives is a harder and more informative discrimination task, and it is why the
contrastive literature (SimCLR, CLIP, E5, bge) uses very large batches. **A batch of 4 is
negative-starved.**

CSHL's first encoder trained at **batch 4** — halved from 8 by the OOM guard on a single
24 GB A10G — and scored MeSH R@10 **0.332** against MedCPT's **0.457**. We attributed the gap
entirely to an objective mismatch (trained doc-doc, evaluated query-doc). That hypothesis is
still live, but **it was never the only one**: the batch size was a second, independent, and
probably material cause, and we did not name it until the next day.

**Rule: never let the OOM guard silently pick your batch size for a contrastive run.** If it
halves, that is a signal to get a bigger box, not to proceed. Data-parallel across 4 GPUs
multiplies effective batch by 4 at roughly the same total cost, because the run is ~4× shorter.

## 2. An unexercised limit produces no error — absence of failure is not evidence of headroom

We told ourselves quota "was not what limited us" because we never saw a quota error. That
reasoning is wrong and it is the same shape as every other failure this project catalogued:
we never saw the error because **we never tried the bigger box**. We sized the plan to what we
assumed was available, so the limit shaped our behaviour invisibly and silently.

Before a long job, check the actual quota and the actual instance menu. Do not infer your
ceiling from the absence of a complaint.

## 3. Capacity ≠ quota, and capacity has its own remedies we had not requested

`InsufficientInstanceCapacity` means AWS physically has no free machines of that type in that
AZ at that moment. Raising a quota does nothing for it. The remedies, in order of strength:

- **Capacity Blocks for ML** — reserve GPU capacity for a future window. Built precisely for
  training runs. This is the request we had not made.
- **On-Demand Capacity Reservations (ODCR)** — hold capacity continuously; you pay whether or
  not you use it.
- **Instance-type flexibility** — a launcher that walks a *menu* (g6e → g5 → g4dn), not just a
  list of AZs for one type. Ours walked AZs only, so one unavailable family stalled it.
- **Region flexibility** — GPU capacity differs sharply by region.

## 4. Long jobs must checkpoint. Non-negotiable if Spot is ever in play

Our 2.3-hour train had **no checkpointing**. On on-demand that was merely lucky; on Spot it
would be reckless, because AWS can reclaim the box mid-run and the entire run is lost.
Checkpoint every N steps to S3 and support resume-from-latest. There is no meaningful quality
or speed cost to doing so.

## 5. Spot + on-demand in parallel is a free extra experiment

Separate quotas mean a Spot box does not consume on-demand headroom. So two variants
(e.g. 40k pairs and 150k pairs) can run **concurrently** rather than sequentially — two data
points in one wall-clock window, with the Spot arm at ~⅓ the price. Requires §4.

## 6. Completion must be an event, not something someone notices

The single largest time loss of the CSHL night — roughly **four hours** — was not any bug. It
was work finishing while nobody was watching: an agent completes its turn and stops, and from
the inside "finished the task" and "finished the night" are indistinguishable. There is no
clock that wakes it.

Two fixes, both required:

- **Never end a turn while a job is in flight.** Hold a loop attached to the running work
  instead of signing off with a status summary.
- **Watch state, not activity.** A file-mtime watcher proves *something changed*; it cannot
  distinguish "working quietly" from "stopped." Poll the actual state — instance list, row
  counts, artifact existence — on a timer.

Ideally the rig itself signals completion (SNS/webhook/queue) so the next step is triggered
rather than discovered.

## 7. Never proxy a third-party PDF from your own servers

Publishers (bioRxiv/medRxiv among them) sit behind bot protection that answers any non-browser
client with 429 regardless of rate — your laptop and your serverless function alike. Hand the
URL to Google's viewer instead:

    https://docs.google.com/gview?url=<encoded pdf url>&embedded=true

Google fetches and renders it; their fetcher is not blocked; the resulting page frames cleanly.
This is the pattern `/Code/policy` already used (`BillPDFSheet.tsx`). Return **two** URLs from
your resolver: the viewer URL for the `<iframe>`, and the canonical PDF URL for "open in new tab".

---

## 8. Benchmark pgvector warm, or you are measuring your cache

**A reported finding was tested and did not survive.** A lane reported that `row_number()` over
an HNSW scan costs **888×** (1,777 ms vs 2.005 ms, same index, same 50 rows), attributing it to
`WindowAgg` re-evaluating the distance expression above an index that already returns rank order.

Retested on the same table (433,449 × 1024-dim, `ef_search=100`), three warm runs each:

    run1  plain 0.21s   row_number 0.35s
    run2  plain 0.31s   row_number 0.31s
    run3  plain 0.25s   row_number 0.26s

**No meaningful difference.** And `EXPLAIN ANALYZE` contradicts the stated mechanism: the
`WindowAgg` shows `actual rows=50` — the `LIMIT` pushes through it, so it never sees the full
partition.

**What almost certainly happened is a cold-vs-warm cache confound**, and this project had already
measured that effect on this very index: **~2 ms warm against ~1,200 ms cold**, because the HNSW
graph is 3,411 MB against 456 MB of `shared_buffers`. My own first attempt reproduced it by
accident — 469 ms then 3.9 ms for the identical query, a 120× swing from warmth alone.

> **A single-shot pgvector timing measures cache state, not query cost.** Any kNN benchmark needs
> repeated warm runs, and any published latency needs p50 *and* p95 with cold and warm stated
> separately.

The generalisable rule is not about window functions. It is: **when a measurement shows a
three-order-of-magnitude effect, suspect the measurement first.**

## 9. Never interpolate a vector into SQL text — bind it

A lane's batch-scoring job hung: a single kNN through `psql -f` took 1.3 s, while the same
statements piped through stdin never returned. The diagnosis stopped at "psql plumbing."

The actual lesson is upstream of that: **the vectors were being interpolated into SQL as literal
text.** A 768- or 1024-float literal is several kilobytes of statement per query; batch them and
you are pushing megabytes of SQL text through a pipe, which is what stalled.

House rule already on the books, and violated here: **pass the vector as a bound `$1::vector`
parameter.** It exists because a join-sourced or inlined probe also defeats the HNSW index — so
binding is both a correctness and a throughput requirement, not a style preference.
