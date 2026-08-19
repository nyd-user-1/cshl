# LANE-UI-ENSDF — new pages, sidebar sections, and the chart-of-nuclides v2

**UI window. Est. 2–3 h. You execute; you do NOT commit or push — the lead handles git and will QA against this spec.**

## DESIGN-SYSTEM CONTRACT — read twice; violations are rejected in QA
1. **No invented styles.** Every color comes from theme tokens (`foreground`, `muted-foreground`, `card`, `border`, `nuclear`, `muted`, `primary`) or the two exported data ramps (`AGE_COLORS`, `XUNDL_COLORS`). You may not introduce ANY other hex/oklch/rgb value, any new font, font size outside Tailwind's scale, or any shadow/gradient not already used in `src/pages/Structure.tsx` / `StructureMass.tsx`.
2. **No new primitives.** Compose from `src/components/ui/*` only. If you believe a needed primitive doesn't exist, use the closest existing pattern and write the gap in REPORT — do NOT build one.
3. **Copy, don't reinvent.** Buttons, tables, cards, badges, section headings, stat chips: find the same element in `Structure.tsx`, `StructureMass.tsx`, `EndfReportCard.tsx`, or `Sidebar.tsx` and reuse its exact class recipe. When in doubt, grep for a similar element and match it.
4. **Inline `style={}` is permitted ONLY for**: canvas dimensions/transforms, data-driven colors from the two ramps, tooltip positioning, and KaTeX HTML injection. Nothing else.
5. **Dark mode is not optional.** Never hardcode white/black backgrounds or text; the Bloomberg dark theme must look intentional on every new page. If you use a data-ramp color as a text/segment background, pick label color by luminance, not by theme.
6. Before reporting done, re-read this contract and audit your own diff against it; note the result in REPORT.

## Ground rules (non-negotiable)
- Repo `/Users/brendanstanton/Code/nsr`. React 19 + Vite + Tailwind 4. **Stick to the design system**: primitives in `src/components/ui/*` (Card, Badge, Button, Input, Tabs, Skeleton), theme tokens (`text-foreground`, `text-muted-foreground`, `bg-card`, `border`, `text-nuclear`, `bg-muted`), existing page conventions (`src/pages/Structure.tsx`, `StructureMass.tsx` are the reference style). TeX in any NSR/physics text renders through `src/components/TexText.tsx`; math-heavy blocks may call `katex.renderToString` directly (KaTeX is installed, CSS auto-imported via TexText).
- **All new routes are lazy** in `src/App.tsx` (follow the existing `lazy(() => import(...))` pattern + the shared `PageFallback`).
- Touch ONLY: `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/ChartOfNuclides.tsx`, `src/pages/Structure.tsx`, `src/pages/GraphPage.tsx`, plus NEW files under `src/pages/` and `src/components/`. Do NOT touch `api/`, `scripts/`, `sql/`, other pages, or any data-generation code.
- Gates before you report done: `npm run typecheck` clean AND `npm run build` clean. Verify each page renders via `npm run dev` (port 3000) + curl won't help (SPA) — use your judgment reading the code; the lead does visual QA.
- U+0000 only ever as an escape sequence in source. No new npm deps — everything needed is installed (`@xyflow/react`, `katex`, `lucide-react`).

## Data already prepared for you (do NOT regenerate)
- `public/data/structure/index.json` — `grid` entries are now **[z, n, a, ageBucket, xundlSetCount]** (5-tuples). `masses[]` unchanged.
- `public/data/ensdf-archivals.json` — `{distributions: [{year, files[]}], latest: {...}}`. Download URL pattern: `https://www.nndc.bnl.gov/ensdfarchivals/distributions/dist{YY}/{file}` where `{YY}` = last two digits of year.
- `public/data/nsdd-repos.json` — 31 IAEA-NSDDNetwork GitHub repos: `{name, description, html_url, language, updated_at}`.
- Source text for prose pages: `data/ensdf-about.html`, `data/ensdf-help.html` (read them; transcribe faithfully, restructured for readability — no scraping needed).
- `data/NDSPolicies.pdf` — **Read this PDF directly (pages 1–6)** for task 4.

## Tasks

### 1. Sidebar: ENSDF group + two top-level items
In `src/components/Sidebar.tsx`, directly BENEATH the "ENDF Reports" button:
- An **"ENSDF" collapsible group** (chevron toggle, same visual language as the "Your Chats" collapsible; icon: `Layers` from lucide). Items (indented, smaller): **About** → `/ensdf/about`, **Help** → `/ensdf/help`, **Evaluation index** → `/ensdf/evaluation`, **Policies** → `/ensdf/docs`, **Datasets** → `/ensdf/datasets`. Active state per `location.pathname`. Default collapsed unless `location.pathname.startsWith("/ensdf")`.
- After the Structure/Graph buttons, two new top-level items: **Tools** → `/tools` (icon `Wrench`), **Code** → `/code` (icon `Code2`).
- Keep the existing hover-prefetch pattern (`onMouseEnter={() => import("@/pages/...")}`) on every new item.

### 2. /tools — NNDC Tools & Publications
New `src/pages/Tools.tsx`. Card grid (the card style of `src/components/EndfReportCard.tsx` is the reference — title, one-line description, external-link icon). Content is FIXED (bake it in, links absolute to nndc.bnl.gov):
- **Structure & decay tools:** 2020 Atomic Mass Evaluation (https://www-nds.iaea.org/amdc/) · BrIcc — Band-Raman internal conversion coefficients (https://www.nndc.bnl.gov/bricc/) · ββ-decay data (https://www.nndc.bnl.gov/bbdecay/) · B(E2; 0⁺→2⁺) values (https://www.nndc.bnl.gov/be2/) · CapGam — thermal-neutron-capture γ-rays (https://www.nndc.bnl.gov/capgam/) · Evaluators' Corner (https://www.nndc.bnl.gov/ensdf/evalcorner/) · LogFT — β-decay log ft (https://www.nndc.bnl.gov/logft/) · Q-Calc — masses, Q-values, thresholds (https://www.nndc.bnl.gov/qcalc/)
- **Reaction tools:** MACS & astrophysical reaction rates (https://www.nndc.bnl.gov/astro/) — verify this URL with one curl; if 404 use the link found on https://www.nndc.bnl.gov/tools/
- **Simulation codes:** GEANT4 (https://geant4.web.cern.ch/) · MCNP (https://mcnp.lanl.gov/)
- **Publications:** Atlas of Neutron Resonances (https://www.nndc.bnl.gov/atlas/) · Nuclear Data Sheets (https://www.nndc.bnl.gov/nds/) · Nuclear Wallet Cards (https://www.nndc.bnl.gov/walletcards/)
- **Manuals (PDFs):** ENDF-102 formats manual (https://www.nndc.bnl.gov/endfdocs/ENDF-102-2012.pdf) · ENSDF manual (https://www.nndc.bnl.gov/ensdf/ensdf-manual.pdf) · NSR coding manual (https://www.nndc.bnl.gov/nsr/docs/nsr-coding-manual.pdf)
Note TeX in names: render `B(E2; 0⁺→2⁺)` and `ββ` via TexText with proper TeX (`$B(E2; 0^+ \to 2^+)$`, `$\beta\beta$`).

### 3. /code — ENSDF analysis & utility codes
New `src/pages/CodePage.tsx`. Fetch `/data/nsdd-repos.json` (react-query, staleTime Infinity). Card grid like /endf: repo name (mono), description, language badge, updated year, link to `html_url`. Split into two sections: repos whose description starts with "LEGACY CODE" → a collapsed-by-default "Legacy codes" section at the bottom (strip the "LEGACY CODE." prefix from displayed text); everything else under "Analysis & utility codes". Header line crediting: "Maintained by the IAEA NSDD network — github.com/IAEA-NSDDNetwork" (link).

### 4. /ensdf/* — five pages (one new dir `src/pages/ensdf/`)
- **About.tsx** — transcribe `data/ensdf-about.html` (what ENSDF is, what it contains, the 20,121 datasets / 3,445 nuclides stat as stat chips, evaluation cadence, NDS journal). Prose in Cards, our typography. Link out to nndc.bnl.gov/ensdf/.
- **Help.tsx** — transcribe `data/ensdf-help.html` into titled sections (General, Browse, Nuclide search, Decay search, Reaction search, Recent additions, Database indices). Use a two-column layout on md+ (sticky mini-TOC left, content right) if simple; otherwise stacked sections.
- **Evaluation.tsx** — OUR evaluation index (NNDC's evaluation-index.html rebuilt). Data: `useStructureIndex()` from `src/lib/structure.ts` — `masses[]` with nested `nuclideEvals[]`. Table: Mass/Nuclide (mass rows bold+link to `/structure/:a`; nuclide sub-rows indented, rendered `<sup>A</sup>El` style) · Citation · Cutoff (with the AGE_COLORS dot, like Structure's table) · XUNDL sets. Intro paragraph explaining cutoff (borrow NNDC's wording). This page must feel like the modern twin of the screenshot everyone knows.
- **Docs.tsx** — **the KaTeX showcase.** Read `data/NDSPolicies.pdf` (pages 1–6) and convert the "General Policies — Presentation of Data", "Theory", and "Summary of Bases for Spin and Parity Assignments" content into a real page: sections, numbered policy lists, and PROPER math — the Weisskopf single-particle estimate T₁/₂(EL) formula, the angular-correlation W(θ) sums, weighted/unweighted average formulas, the Γγ/Γw upper-limits table (as a real <table>), Nordheim rules, E(J,K) band-energy expression. Render display math with `katex.renderToString(tex, {displayMode: true, throwOnError: false})` into `dangerouslySetInnerHTML` (build a tiny local `<MathBlock tex="..."/>` helper in the file). Be faithful to the source content; keep every numbered proposition (1–40 strong, 1–12 weak) even if condensed phrasing. Top of page: a Card noting the source with a button linking to the official PDF (https://www.nndc.bnl.gov/nds/docs/NDSPolicies.pdf).
- **Datasets.tsx** — fetch `/data/ensdf-archivals.json`. Show: latest distribution (prominent card with its files as download links using the URL pattern above), then archived years as collapsible rows (year → file list with links). Add an info note: "These archives are being mirrored to our S3 and parsed into the database (see LANE-ENSDF-ARCHIVE)". Stat chips: total years, total files.

Routes in `src/App.tsx`: `/tools`, `/code`, `/ensdf/about`, `/ensdf/help`, `/ensdf/evaluation`, `/ensdf/docs`, `/ensdf/datasets` — all lazy.

### 5. GraphPage: title inside the canvas
`src/pages/GraphPage.tsx`: delete the header bar div entirely. Inside `<ReactFlow>`, add `<Panel position="top-left">` (import `Panel` from `@xyflow/react`) containing: the back Button (ghost, ArrowLeft → `/structure/${mass}`) + "Chain graph — A = {mass}" (same type styles as before) + the sub-line. Transparent/blurred background (`bg-background/80 backdrop-blur-sm rounded-lg px-3 py-2`).

### 6. Chart-of-nuclides v2 (`src/components/ChartOfNuclides.tsx` + `src/pages/Structure.tsx`)
This is the centerpiece. Target state (mirrors NNDC's chart UX, in our skin):

**ChartOfNuclides component:**
- New props: `mode: "age" | "xundl"`.
- Grid cells are 5-tuples `[z, n, a, ageBucket, xundlCount]`.
- Colors: `mode==="age"` → existing `AGE_COLORS[min(ageBucket,12)]` (index 12 = grey n/a). `mode==="xundl"` → xundlCount===0 → grey `#9ca3af`; else bucket by count: ≤5, ≤10, ≤15, ≤20, ≤25, >25 mapped to `XUNDL_COLORS = ["#15803d","#4ade80","#fde047","#f97316","#ef4444","#7f1d1d"]` (export from `src/lib/structure.ts` along with `xundlBucket(count)` and labels `["≤5","10","15","20","25","≥30"]`).
- **Zoom + pan, fit-to-data default.** Maintain `{k, tx, ty}` state. On data/container-size ready: compute the occupied bounds (min/max N and Z over cells), fit them into the container with ~4% padding, centered — that transform is "home". Draw via `ctx.setTransform(dpr*k, 0, 0, dpr*k, dpr*tx, dpr*ty)` then cells at `(n*CELL, (maxZ-z)*CELL)` with a fixed logical `CELL` (e.g. 6). Wheel zoom toward the cursor (attach a native `wheel` listener with `{passive:false}` in an effect — React's synthetic wheel can't preventDefault), clamp k to [0.5×fit, 10×fit]. Pointer drag pans (grab/grabbing cursor); a click only counts if total pointer movement < 5px. Hover tooltip and click hit-testing must invert the transform. Overlay controls top-left inside the canvas container: small +, −, and ⛶ (reset-to-fit) buttons (Button variant="outline" size="icon", h-7 w-7).
- Container height: give the canvas a fixed aspect/height (e.g. `h-[420px] md:h-[520px]`), canvas fills it.

**Structure.tsx layout rework (top to bottom):**
1. Header: `Nuclear Structure` + subheader exactly: "Mass-chain evaluations and XUNDL compilations." (`text-sm text-muted-foreground`). NO stats here.
2. Chart Card. Card header row: title "Chart of nuclides" (left). Right side: a **Color Code select** (native `<select>` styled to match Input: options "Time since cutoff" | "XUNDL sets since cutoff", drives `mode`) + the **segmented bar legend**: a single horizontal stacked bar (NNDC-style), one flex row of equal segments with the label INSIDE each segment (tiny bold text, white on dark segments / black on light ones), age mode: 12 segments ≤1,2,3,…,10,≥11 using AGE_COLORS[0..11]; xundl mode: 6 segments ≤5,10,15,20,25,≥30 using XUNDL_COLORS, plus a small grey "none" chip after the bar. A caption above the bar: "Years since cutoff" / "XUNDL sets since cutoff" (text-[10px] text-muted-foreground). Legend swaps with mode.
3. The canvas (with its overlay zoom controls).
4. Card footer row: **stats bottom-left** — `295 mass chains · 6,922 XUNDL datasets · N linked papers` (computed as today: sums over masses; bold numbers, muted labels) — and right-aligned hint `drag to pan · scroll to zoom · click a nuclide` (text-xs muted).
5. Section heading "Mass chains", then the **search input** (moved here from the top), then the table (unchanged, cutoff dot still AGE_COLORS).

## REPORT (fill in as you go; the lead polls this file)

- **Status: DONE.** All 6 tasks complete. `npm run typecheck` clean, `npm run build` clean, `npx eslint` clean on every touched file. Nothing committed, nothing pushed.

### Files created/modified
**Modified (all on the allowed list except `src/lib/structure.ts` — see deviations):**
- `src/App.tsx` — 7 new lazy routes (`/tools`, `/code`, `/ensdf/{about,help,evaluation,docs,datasets}`) via the existing `lazy(() => import(...))` + shared `PageFallback`.
- `src/components/Sidebar.tsx` — ENSDF collapsible group (Layers icon, chevron, 5 indented items) directly beneath ENDF Reports; Tools (Wrench) + Code (Code2) after Structure/Graph; hover-prefetch on every new item (Code also prefetches its JSON, matching the Structure item).
- `src/components/ChartOfNuclides.tsx` — v2: `mode` prop, 5-tuple cells, zoom/pan/fit, overlay controls.
- `src/pages/Structure.tsx` — full layout rework per §6.
- `src/pages/GraphPage.tsx` — header bar deleted, `<Panel position="top-left">` inside `<ReactFlow>`.
- `src/lib/structure.ts` — grid type widened to 5-tuples; `XUNDL_COLORS`, `XUNDL_LABELS`, `XUNDL_NONE_COLOR`, `xundlBucket()` exported.

**Created:** `src/pages/Tools.tsx`, `src/pages/CodePage.tsx`, `src/pages/ensdf/{About,Help,Evaluation,Docs,Datasets}.tsx`.

### Gate output (last lines)
```
> nsrgpt@0.0.0 typecheck
> tsc -b
                                    ← no diagnostics

> nsrgpt@0.0.0 build
dist/assets/Docs-BbygJ6c-.js        44.86 kB │ gzip: 14.56 kB
dist/assets/katex-CmbQUdAl.js      260.91 kB │ gzip: 77.67 kB
✓ built in 9.64s
```
eslint on all touched files: 0 errors, 0 warnings (the one remaining `react-hooks/exhaustive-deps` warning in `Structure.tsx:76` is the pre-existing `masses` memo, unchanged from before this lane).

### Verification beyond the gates
Since curl can't exercise an SPA, I server-rendered every new/changed page through Vite's SSR pipeline (`ssrLoadModule` + `renderToString`) with the **real JSON seeded into the QueryClient**, so the loaded branch — not just the skeleton — was exercised. All 9 rendered without throwing:

| page | rendered | note |
|---|---|---|
| Tools | 19 KB | all 5 sections, 17 cards |
| CodePage | 24 KB | active repos rendered, legacy collapsed |
| ensdf/About | 4 KB | |
| ensdf/Help | 8 KB | TOC + 7 sections |
| ensdf/Evaluation | 416 KB | 295 mass rows + nested nuclide rows |
| ensdf/Docs | 344 KB | **1343 KaTeX spans, 0 `katex-error`** |
| ensdf/Datasets | 18 KB | 23 years, 357 files |
| Structure | 163 KB | chart card + legend + table |
| Sidebar | 7 KB | group correctly collapsed at `/` |

Also asserted independently: every one of the 166 TeX expressions in `Docs.tsx` compiles with `throwOnError: true`; the Datasets download URL renders as `…/distributions/dist26/ensdf_260805.zip` (pattern correct); the MACS URL `https://www.nndc.bnl.gov/astro/` returns **200**, so it was kept as specified (no fallback needed).

### Deviations + why
1. **Touched `src/lib/structure.ts`, which is not on the "touch ONLY" list.** §6 explicitly orders `XUNDL_COLORS`/`xundlBucket`/labels to be exported from there, and the `grid` type had to widen to 5-tuples or nothing typechecks. Kept to those two edits, nothing else in that file.
2. **`XUNDL_NONE_COLOR = "#9ca3af"` lives in `structure.ts`** rather than inline in the component, so all "new" color literals sit with the two ramps in one place. The value is the one the spec dictates.
3. **`#000` / `#fff` appear in `Structure.tsx`** — the segment-label ink, chosen by the segment's own relative luminance (`inkOn()`), which is exactly what contract rule 5 requires. These are the only non-ramp literals in the diff; grep confirms no other hex/rgb/oklch, and no `bg-white`/`text-white`/`bg-black`/`text-black` anywhere.
4. **Age legend labels read `≤1 · 2 … 11 · ≥11`, not `≤1 … 10, ≥11`.** 12 segments need 12 labels, and I matched `ageLabel()` (bucket *b* = *b*+1 years) so legend, tooltip, and table dot all agree. Side-effect: `11` and `≥11` sit next to each other — that ambiguity is inherited from `ageLabel`, not introduced here. Say the word and I'll relabel the last segment `≥12`, but that would then disagree with the tooltip.
5. **`style={{ contentVisibility: "auto" }}` on `<tbody>` in `Evaluation.tsx`** is outside the four permitted inline-style uses. It's copied verbatim from `Structure.tsx`'s table (contract rule 3, "copy don't reinvent") and it's what keeps a ~440-row table cheap. Flagging rather than silently keeping it.
6. **Chart data filter — please read this one.** `public/data/structure/index.json` currently contains **2,065 junk cells (21%)**: Z up to 186 and A up to 592, from mis-parsed ENSDF dataset IDs upstream in `scripts/build-structure-data.mjs` (off-limits to me). Fitting to raw bounds gives maxN=950 → k=0.145, cells under 1 px, chart collapses to a sliver in the top third of the canvas. `ChartOfNuclides` therefore filters to `Z ≤ 118 && A ≤ 300` (element 118 is the heaviest confirmed; no known nuclide reaches A=300) before computing bounds, drawing, and hit-testing. Result: 7,859 cells, fit k=0.63, ~3.8 px cells filling 828×450 of a 900×520 canvas. This also stops bogus cells from navigating to `/structure/592`. **The real fix belongs in the data generator** — worth routing to whoever owns that script; the filter is harmless once the data is clean.

### Needs the lead's visual QA
- **Chart interaction on a trackpad.** Wheel zoom uses `exp(-deltaY * 0.0015)` toward the cursor; k clamps to [0.5×, 10×] of fit. Feel is a judgment call — easy single-constant tweak.
- **Legend bar width.** Fixed at `sm:w-[300px] md:w-[400px]` so 12 segments stay readable; below `sm` it goes full-width and wraps under the title. Check the ~700–800 px window where the header row is tightest.
- **Bloomberg dark mode on the two data-heavy new pages** (Evaluation's nested rows use `bg-muted/20` for the sub-rows; Docs' KaTeX inherits `text-foreground`, i.e. amber). KaTeX in amber-on-black is the thing I'd most want a human eye on.
- **`ensdf/Evaluation` renders `⁴Nn`** for A=4 — that's a real `nuclideEvals` entry with `el: "NN"` in the source data (tetraneutron), not a render bug. Confirm it should be shown as-is.
- **Γγ/Γw table footnote markers** (page iv of the PDF) were reconstructed from the printed layout — the `a`/`#`/`†`/`§` placements are my best read of the source; all footnote *text* is verbatim. Two cells (E4 and M4, column A>150) are blank in the source and render as `—`.
- **Docs page length.** Every numbered proposition is present (strong 1–40, weak 1–12) as required, which makes it a long page. No TOC there — say if you want one like Help's.

### Gap noted, not built (contract rule 2)
There is no Collapsible/Accordion, Select, or Table primitive in `src/components/ui/*`. Rather than add one I reused existing recipes: the "Your Chats" chevron pattern for all three collapsibles (Sidebar ENSDF group, CodePage legacy section, Datasets year rows), the `Input` class recipe on a native `<select>` for the color-code picker (as §6 directs), and `Structure.tsx`'s table recipe for both new tables. If these keep recurring, `ui/collapsible.tsx` and `ui/select.tsx` are the two worth promoting.
