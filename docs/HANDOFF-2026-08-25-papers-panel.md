# Handoff — 2026-08-25: the Papers panel, the search-result card, and a real hybrid

Twelve commits, `d81c087` → `f6a36d8`, all on `origin/main` **and all live**.
This repo has Vercel's GitHub integration: every push to `main` triggers a
Production deployment. Verified — `gh api repos/nyd-user-1/cshl/deployments`
shows `vercel[bot]` building each of today's commits within two minutes of the
push, and the live bundles carry today's strings.

---

## 1. The one that matters most: Hybrid was never hybrid

`useRecordSearch` mapped every non-keyword mode to `mode=semantic` and added an
`arm=dense` param. `api/search.ts` resolves `wantsFts = requested !== "semantic"`
and **never reads `arm`**. So:

- `hybrid` never ran the lexical arm and never fused,
- Hybrid and Semantic in the dropdown were byte-identical requests,
- and since Hybrid is the default, **every search in the app was dense-only** —
  `/search`, `/references`, and the new Papers panel.

Fixed in `227e476`: the mode goes through as it is, the dead `arm` param is
gone. Measured against production, `parental smoking children respiratory`:

| | served mode | arms |
|---|---|---|
| before | `semantic` | 100/100 dense |
| after | `hybrid` | 43 dense · 46 fts · 11 both |

Fusion also does its job — the paper whose title *is* the query moves from #2 to
#1 — at 928 ms vs 806 ms, so this bought correctness for no real latency.

⚠ **The retrieval numbers in the earlier reports were measured by calling
`/api/search?mode=hybrid` directly.** They describe the API, and until this
commit they did not describe the product. They do now.

---

## 2. The Papers panel (`/chat`, second top-bar icon)

A document icon beside the pulse opens the same `ResearchFeed` aside in a second
mode: the newest preprints instead of activity. Clicking the other icon swaps
the content; clicking the same one closes it.

- **Data:** `useRecentPapers` — `useInfiniteQuery` over `/api/records` at 12 rows
  a page, ordered `pub_year DESC, posted_date DESC`. `AppLayout` calls it on
  mount, so the panel opens from cache. An `IntersectionObserver` 400 px above
  the bottom pulls the next page.
- **Search:** the same `SearchInput` pill as `/references`, pinned under the
  header, running `useRecordSearch` — same hook, same three-character floor,
  same cache keys as `/search`. Empty field falls back to the recent list.
  Infinite scroll is suppressed while searching (a search is a bounded set).
- **Card:** `SHELL_CLS` + `WidgetHeader` — the box the /search widgets are drawn
  in — wrapping `RecordRow`. Header is `grip · key number · ✕`.
- **Drag:** the card is the drag unit. It carries its whole record in the
  payload (`paperEntity` → `DragEntity.context`), so a drop needs no fetch.
  Drop it on the chat input and it attaches as the conversation's context until
  the ribbon's ✕ clears it; an empty input also gets seeded with
  `Tell me about "<title>"`.

### Two things about drag-and-drop that cost four rounds

1. **The drag image.** Chrome's *auto-generated* drag image composites the
   element snapshot onto its own padded backing plate with a shadow — which
   reads as a box drawn around the card. You cannot style that plate. The fix is
   `setDragImage(e.currentTarget, …)` with the grab offset, naming the element
   explicitly. Do not "fix" this by inventing a substitute ghost; the card is
   what should follow the cursor.
2. **The drop treatment is ChatDock's**, not a new one: dashed blue border on
   the container plus the "Drop to attach as context" note.

---

## 3. Extractions — the shared pieces this created

Four things were private to one file and are now shared. If you need one of
these, it exists; do not write a second.

| module | what | used by |
|---|---|---|
| `components/RecordRow.tsx` | the search result row, `variant: "row" \| "card"` | `/search`, Papers panel |
| `components/WidgetCard.tsx` | `SHELL_CLS` + `WidgetHeader` (`gripFirst`) | `/search` widgets, Papers panel |
| `components/ui/tooltip.tsx` | `Tooltip` + `TOOLTIP_SURFACE` | row actions, top bar, chart tooltips |
| `lib/highlight.tsx` | `highlightText` | `RecordCard`, `RecordRow` |

**`highlightText` carried a bug into the extraction and it is fixed there:** it
chose which fragments to wrap with `regex.test(part)` on a `g`-flagged regex,
whose `lastIndex` advances between calls, so alternate matches went unmarked.
`split` with a capture group already puts matches on odd indices — the index is
the test now.

**The tooltip is portaled to `document.body`** and positioned from the trigger's
rect, because an in-flow bubble is clipped by any scrolling or overflow-hidden
ancestor (the top bar sliced its own icons' labels off). That means the reveal is
state, not `group-hover` — a portaled node is not a descendant of the trigger.
`side` picks the direction; the top-bar pair pass `"bottom"`.

⚠ `Tooltip` is imported **aliased as `Hint`** in `pages/Search.tsx`, because
recharts exports its own `Tooltip` into that module.

---

## 4. Smaller UI changes

- `/search` result rows: the **title** is the heading (the key number told a
  reader nothing and still travels as the DOI), abstract beneath it, DOI link
  with the house wipe underline and the icon trailing the text.
- Row actions: `Open Record` and `Ask Chat` (was "Chat about this record"),
  native `title=` removed so there is no doubled browser tooltip.
- Widget colour: **`#004982`**, sampled from `public/cshl-logo.png` where the
  seal fills 64,323 px of exactly that value. It replaced the inherited NSR
  orange in the bars, both lines and both scatters; axis ticks moved from the
  matching gold to `#4E7695`; the stacked-area ramp is a seven-step blue.
- Default widget order puts Cumulative and Relevance directly under the year
  bars.

---

## 5. State, and what to check first

- **`main` is clean and pushed.** Working tree still holds the model-card work
  from the 08-24 session — two staged renames/deletes under
  `scripts/publish-nsr/cards/` and eight untracked cards plus
  `docs/BAKEOFF-AWS-2026-08-20.md`. **None of it is mine**; every commit above
  was made by explicit pathspec so it stayed out. Decide what to do with it.
- **Deploys are automatic — push to `main` and it ships.** No CLI step. What to
  know instead: **a deploy purges the edge cache**, and `/api/records` cold is
  **5.9 s** against 265 ms warm (Neon scale-to-zero plus a cold function), so the
  first Papers open after any push is slow. It is not the panel's fault — it
  shows skeleton cards rather than the word "Loading" so it does not read as
  broken.
  ⚠ `HANDOFF-2026-08-19.md` §"Open items" says production is deployed by hand
  with `vercel deploy --prod`. That was true of that day, when 60 commits sat
  unpushed and nothing could auto-build. It is not true now, and reading it as
  current is how this memo shipped with the same wrong claim in its first
  version.
- **Verify the two things I could not:** that the drag image is now tight to the
  card (if Chrome still draws its plate over an explicitly-set element image,
  the fallback is a clone sized to the card), and that the top-bar tooltips open
  downward and uncropped.

## 6. Open

1. **The AND bug survives in the subject-room widening query.** The main FTS
   arm is OR-with-high-DF-pruning, as `MORNING-BRIEF.md` §4 asked. But
   `api/search.ts:273-276` — the path that widens a subject-scoped chat to the
   whole corpus when in-room evidence is weak — still uses
   `websearch_to_tsquery`, which ANDs. That is the shape that returned 0–6 rows
   out of 433,449 for a multi-concept query, so the widening can silently fail
   to widen exactly when it is needed. Same `tq` CTE the main arm uses would fix
   it. (The other `websearch_to_tsquery`, at :205, is the deliberate fallback
   for when pruning empties the query — leave that one.)
2. The card's abstract clamps at two lines because `RecordRow` is shared with
   the search results. Give the `card` variant its own clamp if the panel should
   show three.
3. `npx tsc -b` does not typecheck `api/` — only a deploy catches errors there.
   Every commit above was gated with `npm run build`, which covers `src/` only.
