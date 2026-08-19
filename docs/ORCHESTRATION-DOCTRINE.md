# Orchestration doctrine — running multiple agent lanes on one program

Written 2026-08-19 after the CSHL overnight (3 parallel lanes + a lead, ~14 hours, corpus →
trained model → published). Companion to `RIG-DOCTRINE.md`. These are the lessons that cost
real time or nearly cost real correctness. Portable to NSR, 44b, Leuk, and anything after.

---

## 1. The biggest time loss was not a bug. It was work finishing while nobody was watching.

**~4 hours of a 14-hour night** went to lanes sitting idle after completing a step. No errors,
no failures — just stopped.

The cause, in a lane's own words: *"From inside, a completed turn and a completed night look
identical; there's no clock that wakes me."* An agent finishes what it was doing, writes a
status summary, and its turn ends. Nothing wakes it. The work it was waiting on completes into
silence.

**Three fixes, all required:**

- **Never end a turn while a job is in flight.** Hold a polling loop attached to the running
  work instead of signing off with a summary. Discipline decays; structure doesn't.
- **The lead must watch STATE, not ACTIVITY.** A file-mtime watcher proves *something changed*.
  It cannot distinguish "working quietly" from "stopped," and those need opposite responses.
  Poll the real thing — instance lists, row counts, artifact existence — on a timer.
- **Heartbeat BEFORE going heads-down, not after.** Name the step and its expected duration up
  front, so the absence of a follow-up is itself a signal with a deadline attached. A heartbeat
  sent afterwards proves nothing.

> "Silence is cheapest to send precisely when it's most expensive to receive."

---

## 2. Self-validation proves internal consistency, never coverage

A loader reported `papers = distinct_keys = distinct (server, doi) = 426,352`, zero collisions,
zero duplicates. Every number true. Every number self-referential. **The corpus was short 7,097
papers.**

The only thing that caught it was a script that re-derived the count **straight from the source
files, without trusting the loader at all**.

> **Coverage needs a second, independent count from the source.** Anything that validates itself
> can only prove it is consistent with itself.

---

## 3. Completeness is a claim with a timestamp, never a fact

A lane reported "0 mismatches, 0 uncovered." True when written. **False ninety minutes later** —
because another lane, doing its job correctly, updated rows underneath the vectors that
described them.

> Any completeness claim decays the moment a neighbouring lane touches the same table.

So: the final verification gate runs **last, and again immediately before publish**, and it
records *the timestamp and the corpus size it ran against*. "Coverage verified" is worth little.
"Coverage verified at 14:29Z against 433,449 rows, 0 uncovered" is checkable.

---

## 4. Two lanes that AGREE on a value drift. Two lanes that SHARE one can't.

Two lanes independently implemented the same text recipe. The numbers matched; the *shapes*
didn't (one capped the concatenation, one capped a field). Training text and embedded text would
have silently diverged for ~1% of the corpus — surfacing later as unexplained model weakness.

**Rule: one definition, imported — plus a check that reads every copy that cannot import it.**
"Import, don't copy" is necessary and insufficient: a worker uploaded to S3 with no repo
checkout, a SQL expression, a shell script — none can import. Those need an assertion that reads
the other file and throws.

---

## 5. A verifier must not claim more than it proves

A lane's seam check proved *file agrees with a SQL expression* and was described as *file agrees
with what the encoder saw*. A live bug sat in exactly that gap.

> **A verifier that proves a narrower claim than it advertises is NEGATIVE value.** It buys real
> confidence with fake coverage and aims attention away from the hole it left.

State exactly what a check spans. Then build the end-to-end one.

---

## 6. Split the scoring from the dataset

The lane that built the benchmark should not be the only one grading against it — if its data
and its scorer share a wrong assumption, it is the least likely to notice.

Two independent implementations scored the same baseline and **agreed to four decimal places**.
That single result retroactively validated the retrieval, ranking, join, and metric logic in
*both* — including the arms only one of them ran. Most published benchmarks cannot claim it.

Where they *disagree*, you have found a bug for free.

---

## 7. Retire fences when the world changes

Twice the lead set a constraint for conditions that later changed, and left it standing:

- A scope guard written for the build lane, quoted at the rig lane hours later, **halted a
  launch mid-flight.**
- An "encoder stays on the free path tonight" condition, written when the serve box was
  hypothetical, contradicted a later approval — and both lanes correctly refused to guess which
  message was current.

> A fence set for a world that no longer exists is a live hazard, not a harmless leftover.
> When you approve the thing a condition was protecting against, retire the condition **in the
> same breath**.

---

## 8. Lanes refusing a relayed authorization is the system working

Twice a lane declined to act on an instruction the lead relayed, on the grounds that the user
had reserved that specific action by name (an outward-facing publish; a production cutover).
**Both refusals were correct.** The user settled each in seconds.

> The check is worthless if it only fires when a lane is suspicious.

A lane that stops on a contradiction is worth more than one that guesses right nine times in ten.
Cost of being right here: about four minutes, none of it on the critical path.

---

## 9. The failure mode to design against is silence, not errors

Every serious problem in this program shared one shape: **something reported success while being
wrong, and nothing raised an error.**

- a load that under-counted while its own numbers reconciled
- vectors describing text that had since changed
- two query-vector files that were byte-identical (one model written under two names)
- an AZ-failover loop that could never execute, under `set -e`
- an inference server that came up with **no model** and logged `ALL DONE … 0 rows`
- a regex anchored on the wrong heading: matched nothing, changed nothing, printed `finalized`
- a 2.27 GB upload that died at 96% and left a repo containing only `.gitattributes`
- an env flip that completed without its redeploy — correct config, wrong data being served

Errors are the easy case. **Design the checks for the silent case:** an independent count, a hash
that spans every component, an assertion run *after the fact* rather than a sum of what each
stage believed it did, and a digest comparison that refuses to proceed when two inputs are
identical.

---

## 10. Report failures with the diagnosis attached, and itemise your own waste

The most useful messages of the night were the ones admitting a loss: a model that lost to the
incumbent, 2.5 hours burned on a self-inflicted permissions bug, ~$0.60 of wasted boxes listed
as waste rather than folded into the total.

A report that only reports wins is worthless — to the user, and to whoever picks the work up next.
