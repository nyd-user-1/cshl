# Overnight findings — 2026-08-21

Written by the advisor window while Brendan slept. Findings, not tasks. Nothing
here required a decision overnight; everything is verified against artifacts
rather than lane summaries.

## 1. The classifier clears its gate — and I got this wrong at first

D10 required cshl-category to be scored against **two** baselines. The lane
reported only the majority-class floor (14.45%), which for a 76-way target
proves very little. The gate that mattered was the other one: *"a model that
cannot beat kNN-over-embeddings is not worth serving."* Nobody ran it, so I did
(`scripts/eval/knn-category-baseline.mjs`, read-only, $0).

| baseline | top-1 | top-3 |
|---|---|---|
| majority class | 14.45% | — |
| **kNN over `preprint_embeddings_cshl_qp2`, k=15, n=1,200** | **59.25%** | **85.00%** |
| cshl-category (lane's number, n=32,794) | **65.09%** | not reported |

**Verdict: the classifier earns its keep by ~5.8 points.** The kNN sample's 95%
interval is [56.5%, 62.0%], so 65.09% sits well outside it.

**Correction to my own interim note:** a 300-paper pilot put kNN at 63.0% and I
reported the two as indistinguishable. That was sampling noise — the 1,200-paper
run moved it to 59.25%. The pilot number was wrong; this one supersedes it.

**Unreported and worth asking the lane for: top-k.** kNN's top-3 is 85%, and the
classifier's top-3 was never measured. It is almost certainly ~90%, and it is the
decision-relevant figure, because the classifier's product jobs (sub-room
disambiguation, room suggestion) can surface two or three options rather than
one. Its gold label is author self-assignment on papers that legitimately span
categories, and both models' confusions are the same overlapping-field pairs
(epidemiology↔infectious diseases, and so on). The gap between ~65% top-1 and
~90% top-3 is mostly label ambiguity, not model error — which argues for a UI
that offers a few rooms rather than asserting one.

**Also unreported: macro F1 is 50.44% against 65.09% accuracy.** The tail
categories are weak. Since small rooms are exactly where a labeller would help
most, a per-class breakdown is worth having before trusting it to populate them.

## 2. A phantom submodule is sitting on `lane/librarian`

The rooms lane created its worktree *inside* the shared repo
(`.claude/worktrees/rooms`). The librarian lane's `git add -A` then swept it up
as a **gitlink, mode 160000**, pointing at commit `e0d5f45` — which exists only
on a local branch. Merged to `main` as-is, fresh clones break: git will try to
resolve a submodule that has no `.gitmodules` entry and no reachable commit.

Done: `.claude/worktrees/` is now ignored on `main` (`33f5a65`), so it stops
recurring. **Still needed:** drop the path when `lane/librarian` merges —
`git rm --cached .claude/worktrees/rooms`. I did not reach into a running lane's
branch to do it.

## 3. The real risk to the full-text plan is egress, not design

From the rooms lane's own commits: bioRxiv **429s Vercel's egress**, and
`r.jina.ai` **403s** it. That is datacenter-IP rate limiting, and it threatens
the fix that matters most — the generator finally reading paper bodies. The lane
responded with a fetch ladder ending at a Wayback rung, which is sound, but
Wayback coverage of recent preprints is thin, so the ladder's bottom rung will
miss exactly the newest papers. If the acceptance test passes, this is fine for
now; if answers are inconsistent paper-to-paper, this is why. A durable fix is
fetching server-side from somewhere with a residential/managed egress, or
backfilling full text in bulk from the JATS URLs (which are populated for
433,449/433,449 rows) rather than fetching per turn.

That lane also caught a flaw in my handoff worth recording: I wrote "if in-room
results are weak, widen," but exact kNN always returns its LIMIT, so a row count
can never mean "weak." They replaced it with an evidence-based test. Good catch.

## 4. Lane status at time of writing

- `lane/librarian` — 3 commits, category model trained and scored, room map
  gap closed (36,212 → 0) via a half-year fallback. No COMPLETE/BLOCKED yet.
  **Watch:** the half-year axis is the one D10 named as a last resort. A room
  the user cannot meaningfully choose ("neurology, 2021 H1") is a routing
  problem, because navigation is the router. Worth reviewing the room map
  before it is built into the UI.
- `lane/rooms` — 3+ commits, deep in the full-text fetch ladder and chat
  timeouts. No COMPLETE/BLOCKED yet.
- `main` — carries tonight's two generation fixes (abstracts uncut; the false
  "not yet published" string removed), the handoff, the worktree ignore, and
  the baseline script.
