# LANE-PROOF — the model announcement page

Append-only, timestamped. Mission: a launch page for the model program at
`/announcing` on cshl.nysgpt.com (RxivGPT), in the register of an Anthropic model
post — confident, visual, skimmable in 30 seconds, credible on a 5-minute read.

Fences observed: `src/`, the route table and this log only. No deploy. No messages to
other sessions. Nothing heavy on the laptop (one Vite build, one preview server, four
headless screenshots; no GPU, no network egress, no database).

Predecessors read end to end before any copy was written: `docs/CSHL-CPT-REPORT.md`
(1,188 lines), `docs/prompts/LANE-WIN.md`, and the sections of `LANE-RERANK.md` and
`LANE-QPAIRS-RUN.md` the report cites.

---

## Status

**COMPLETE.** Built, gated, committed to `lane/proof-page`. Not deployed — Brendan
reviews first.

---

## Log

### 2026-08-20 — lane start, and the one claim in the brief that is not true

The brief's example availability line is *"Live now on cshl.nysgpt.com — every search
runs on it."* **It does not.** `api/search.ts` is Postgres full-text only: `mode=semantic`
and `mode=hybrid` both fall through to the FTS path and say so in the payload
(`degraded: true`). The encoder serves the **dense arm of `/chat` retrieval**
(`api/chat.ts`, `denseP`), which is the primary interface and where every RAG answer
comes from — but it is not what a reader would understand by "every search."

Changed to **"Live now on cshl.nysgpt.com — every question you ask RxivGPT retrieves
through it,"** which is exactly true, and the fine print states plainly that the keyword
search page runs full-text only today. For the same reason the primary CTA points at
`/` (chat, where the model actually runs) with `/search` as a secondary button rather
than the headline one. A launch page whose first factual claim is checkable and wrong
costs more than the extra clause costs.

**The brief's "+25% on the deployed configuration" also does not appear in any source
document** and could not be reproduced from one. The page uses the measured live
change instead: the dense arm moved from stock `BAAI/bge-m3` (MeSH R@10 **0.2861**) to
`cshl_qp` (**0.4319**) — **+51%** — with author keywords 0.6522 → 0.7497 (+15%).
`vectorTable("nsr")` on `main` is `preprint_embeddings_cshl_qp`, so the "live" claim is
verified in the code that ships, not inferred from the report.

### Numbers on the page, and where each comes from

Everything is from `docs/CSHL-CPT-REPORT.md` (which cites the lane logs) at the
frozen `cshl-eval-2k` subsample — 2,000 queries, MESH 1,241 / AUTHORKW 759.

| element | value | source section |
|---|---|---|
| corpus | 433,449 (bioRxiv 345,882 + medRxiv 87,567) | "The corpus" |
| chart 1, MeSH R@10 | 0.5197 / 0.4569 / 0.4512 / 0.4319 / 0.3513 / 0.3320 / 0.2861 / 0.0806 | "The qpairs run", "Results" |
| chart 1, AUTHORKW R@10 | 0.8300 / 0.8076 / 0.7655 / 0.7497 / 0.7260 / 0.6693 / 0.6522 / 0.2398 | same |
| chart 2, blended R@10 | 0.6510 / 0.6500 / 0.6160 / 0.5900 / 0.5525 | "System vs system" |
| MeSH parity | −0.0250, p = 0.071, CI [−0.0516, +0.0016] | "The qpairs run" |
| reranker on MeSH, same pool | +0.0193, p = 0.0127 | "System vs system" |
| system loss | −0.0350, p = 0.0002 | "System vs system" |
| training | 39,999 pairs of 424,753, L40S, 55 min, 1 epoch | "What was trained" |
| spend | $2.95 this run · $11.92 program | spend ledgers, summed: 6.70 + 2.95 + 2.04 + 0.23 |

**Nothing is rounded up and every loss is on the page**, not only in the footnotes: the
author-keyword loss is a bar on the main chart, the system loss is the top bar of the
second chart and is named in its caption, and the doc→doc regression, the
objective/batch-size confound, the SPECTER2-without-adapter caveat and MedCPT's
possible PubMed familiarity with these papers are all in the fine print. The QP2 run
in flight in `lane/rxiv-load` is **not** on the page — it has no result yet.

`$11.92` is a sum this lane performed over four ledgers ($6.70 + $2.95 + $2.04 +
$0.23); the components are itemised in the report, the total is not. Flagged because a
number nobody wrote down is exactly the kind that gets quoted back.

### Build

- `src/pages/Announcing.tsx` — the page. Hero, two inline-SVG bar charts, four
  claim sections, CTA, fine print. No chart library (Recharts is already in the bundle
  for other pages; this one ships 24 kB / 8 kB gzipped and pulls in nothing new).
- `src/App.tsx` — lazy route `/announcing`, same pattern as every other page.
- `src/index.css` — two new chart tokens per theme, in the existing `@theme` / `.dark`
  idiom rather than hardcoded hexes in the SVG.
- `src/components/Sidebar.tsx` — the site has no footer; the bottom of the sidebar
  above the user menu is where site-level links live, so the link went there.

**Charts.** Horizontal bars, one measure, one baseline, ≤ 24 px thick with a 4 px
rounded data-end, hairline gridlines, value at each tip in a text token rather than in
the bar's colour, per-row hover tooltip, family toggle on the retrieval chart. Below
620 px the label moves above the bar and the bar spans the full width, so no label is
ever clipped. Fusion arms are hatched as well as coloured, so "contains one of ours"
never rests on hue alone.

**Colour was computed, not chosen.** The two categorical fills were run through the
dataviz validator against each surface:

```
light  #3d93f5 / #6b6b78   CVD ΔE 18.9 · normal-vision 19.9 · both ≥ 3:1 contrast
dark   #0d9ed6 / #9a8340   CVD ΔE 20.8 · normal-vision 21.8 · both ≥ 3:1 contrast
```

The site's own `--color-nuclear` (`oklch(0.708 0.165 254)` / `#00BFFF`) failed the
light-mode contrast check at 2.55:1 and sat outside the dark lightness band, so the
chart fills are re-stepped neighbours of it rather than the token itself; the token
still carries every non-chart accent on the page so the family resemblance holds. The
validator's remaining FAIL is the chroma floor on the neutral, which is deliberate —
"not one of ours" is a de-emphasis, not a competing hue.

### Verification

```
npx tsc -b        exit 0
npm run build     exit 0     (dist/assets/Announcing-*.js  23.81 kB │ gzip 8.18 kB)
```

Both exit codes read from `$?` on their own line, not inferred from output. `zsh` does
not populate `PIPESTATUS`, so the first build was re-run without a pipe to get a real
code — worth recording, because `npm run build | tail` returns *tail's* status and
would have reported success for a failed build.

Rendered and looked at, which the validator cannot do: Chromium headless at 1280 px
(light and dark) and at 390 px (dark), top and bottom of the page. Found and fixed two
things a screenshot catches and a type-checker does not — the second chart's legend
advertised a hatch pattern no bar on it used (the mixed MedCPT-pool/our-reranker row is
now correctly marked a fusion), and the final axis tick overhung the right edge on
narrow viewports (last tick is now end-anchored).

*Screenshot trap worth recording:* Chrome's old headless mode lays the page out at its
default viewport and then crops the capture to `--window-size`, so a 390 px screenshot
looked catastrophically overflowed while the page was fine. Confirmed by measuring
instead of eyeballing — `documentElement.scrollWidth` 390 against `clientWidth` 390,
with the only off-screen elements being the intentionally off-canvas research feed.
The honest mobile capture is the page inside a 390 px-wide iframe in a wider window.

### Not done, deliberately

- **Not deployed.** No `vercel` invocation of any kind. Brendan reviews first.
- Not merged, not pushed.
- `/features` still carries NSR-era copy (OpenAI embeddings, GPT-4o, "88,000+ NSR
  records") that contradicts this page. Out of scope for this lane, and worth a pass
  before anyone links the two.
