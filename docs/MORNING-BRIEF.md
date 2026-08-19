# Morning brief — decisions waiting for Brendan

Nothing here blocked the night. Each item is a decision that is genuinely yours, recorded
rather than guessed at. Written 2026-08-19 ~02:40 by the lead.

## 1. Licence posture on the published datasets — the one real decision

rig-port measured the licence mix while fixing a card-filler bug that would have asserted
**"99.9% Creative Commons"** — close to the opposite of the truth. bioRxiv/medRxiv use
`cc_no` to mean **all rights reserved**, so a `LIKE 'cc%'` prefix match counts the single most
restrictive value as permissive. Enumerated, over 197,539 papers:

| licence | share | derivatives redistributable? |
|---|---:|---|
| `cc_by_nc_nd` | 35.5% | no |
| `cc_no` | 29.9% | **no — all rights reserved** |
| `cc_by` | 20.2% | yes |
| `cc_by_nc` | 6.8% | yes, non-commercial |
| `cc_by_nd` | 6.4% | no |
| `cc0` / `cc0_ng` | 1.1% | yes |

**~72% carries a licence restricting derivative redistribution, commercial use, or both.
Only ~21% is cleanly `cc_by`/`cc0`.**

**Bearing on us:** `cshl-triplets` contains abstract text, and `cshl-eval-v1` inlines
`embed_text` so the benchmark is self-contained — right for reproducibility, awkward for
licensing, simultaneously. **Everything published tonight is PRIVATE, so nothing has crossed
a distribution line.** The decision is only live if someone reaches for public.

**Two things that are NOT the same question,** and will be conflated if we let them:
- *Displaying* abstracts in the app, with attribution and a link to source, is what every
  literature search surface does and what the public API exists for. **The cutover is not
  implicated.**
- *Redistributing* abstracts in bulk as a downloadable dataset is the actual question.

**Options, cheapest first:**
1. **Keys-only public variant.** Publish `doi` + `server` + labels; consumers re-fetch text
   from the public API themselves. Nearly free — lane-mine already put `doi` + `server` on
   every frozen row for the long-context case, so the mitigation already exists.
2. **Restrict a public slice to the ~21%** that is `cc_by`/`cc0`.
3. **Ask CSHL for an explicit position.** NSR has the identical question open with NNDC,
   still unanswered.

Recommendation: option 1 if you want anything public; otherwise leave private, which costs
nothing. Guard requested: publishing a text-bearing artifact with public visibility should
fail loudly, and the licence table lives in the card itself.

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
