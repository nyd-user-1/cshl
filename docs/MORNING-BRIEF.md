# Morning brief — decisions waiting for Brendan

Nothing here blocked the night. Each item is a decision that is genuinely yours, recorded
rather than guessed at. Written 2026-08-19 ~02:40 by the lead.

## 1. Licence posture — CLOSED, not a decision

Brendan closed this and asked not to be brought it again. Repos publish **private** per his
explicit instruction earlier ("use the nsr token, publish but private, naming prefix is 'cshl'")
— not as a licensing remedy, and I should not have framed it as his reasoning. No open item.

Retained only because a card nearly published a false claim: bioRxiv/medRxiv use `cc_no` to mean
all rights reserved, so `LIKE 'cc%'` scored the most restrictive value as permissive and the
filler would have asserted "99.9% Creative Commons." Enumerated over 197,539 papers: `cc_by_nc_nd`
35.5%, `cc_no` 29.9%, `cc_by` 20.2%, `cc_by_nc` 6.8%, `cc_by_nd` 6.4%, `cc0`/`cc0_ng` 1.1%. The
card states the measured mix instead of the prefix-matched fiction. That is a correctness fix,
nothing more.

## 2. HF token — your ruling stands, rotation is the follow-up

You ruled: NSR token, private, `cshl-*` prefix. Done. The open item is minting a CSHL-scoped
token so the two projects don't share a credential. Two minutes when you're up.

## 3. Coordination failures, recorded rather than sanitised

Both in the BUILD addendum in full. Summary: a scope guard from the ingest lane's original
kickoff — written hours before the rig lane existed and scoped to the ingest lane's own brief
— was quoted at rig-port as current and halted a rig mid-launch. My gap: I never superseded it
when you approved the launch menu. Cost: ~$0.03 and a few minutes.

Twice, a lane refused an authorization I relayed (the HF push; the production cutover) on the
grounds that you had reserved that specific action by name. Both refusals were correct and you
resolved both in seconds. That is the check working, and it is why the program can run
unattended — the check is worthless if it only fires when a lane is suspicious.

## 4. PRODUCTION BUG FOUND — keyword search is running conjunctive (AND) semantics

Found by lane-mine while scoring baselines, and it is a live product defect, not a benchmark
artifact. `api/search.ts` uses `websearch_to_tsquery`, which treats space-separated terms as
**AND**. Measured match counts against the 433,449-paper corpus, five real queries:

| query | family | matches (AND, production) | matches (OR, conventional) |
|---|---|---:|---:|
| 0 | AUTHORKW | **1** | 118,801 |
| 1 | MESH | **6** | 188,987 |
| 2 | AUTHORKW | **0** | 107,567 |
| 3 | MESH | **1** | 23,592 |
| 4 | AUTHORKW | **1** | 33,569 |

**A multi-concept query returns 0–6 documents out of 433,449.** Any user typing more than a
couple of words into keyword mode gets almost nothing back.

Quantified on the frozen 2,000-query subsample, both arms scored identically otherwise:

| FTS arm | MeSH R@10 | Author-keyword R@10 |
|---|---:|---:|
| AND — what production serves today | 0.081 | 0.240 |
| OR + `ts_rank_cd` — conventional lexical | **0.095** | **0.354** |

**Switching to OR semantics is +17% on MeSH queries and +47% on author-keyword queries**, on
the same index, same corpus, same queries. It is a one-line change to the tsquery construction
in `api/search.ts`.

Not fixed tonight — it is a behaviour change to a live search surface and it was found at 06:30
while the training pipeline held priority. Recommended as the first thing to ship today.
