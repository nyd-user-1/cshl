# HANDOFF — /graph next batch (Brendan-approved, execute in order)

> **✅ CLOSED 2026-08-18 (all five sections done and pushed).** Sections 1–4
> merged long ago (`91acc50`…`1513247`, in `origin/main`); `FlowSettings` is
> wired into `GraphPage.tsx` (imported line 15, `flowProps` spread into
> `<ReactFlow>` — the "props block at 1002-1021" line numbers below are dead,
> the file is now ~1,700 lines). Section 2's `op=similar` is implemented at
> `api/graph.ts` and follows the `SEARCH_ENCODER` switch. Section 5's
> deliverables (LANE-EVAL, LANE-TRIPLETS) both ran to COMPLETE — see
> `docs/NSR-CPT-REPORT.md`. Nothing below is a live work order; kept for the
> design rationale and house rules only.

> STATUS 2026-08-16 (account-3-ui session): sections 1–4 DONE and committed
> locally (91acc50 → 1513247), typecheck + vite build green per commit, NOT
> pushed. Section 5 (LANE-EVAL / LANE-TRIPLETS) untouched — model-phase lane,
> left for the embeddings window. Not browser-verified (no headless browsers
> on this device) — please click through /graph once before pushing.

State: everything through `42d2eae` is pushed and live. Working tree clean
except the other windows' artifacts (leave those). `FlowSettings.tsx` is
COMPLETE but UNWIRED. The embed lane is DONE (nsr_embeddings, 277,068 rows,
HNSW built, warm kNN 1 ms) — similarity edges are unblocked.

## 1. Wire FlowSettings into GraphPage (scoped, do first)

- `import { FlowSettingsPanel, DEFAULT_FLOW_PROPS, type FlowProps } from "@/components/FlowSettings";`
- Enums: `import { SelectionMode, ConnectionMode, ConnectionLineType, PanOnScrollMode } from "@xyflow/react";`
  Map strings→enums: selectionMode full/partial; connectionMode strict/loose;
  connectionLineType default→Bezier, straight/step/smoothstep/simplebezier;
  panOnScrollMode free/vertical/horizontal. Empty keyCode string → null.
- State: `flowProps` (merge DEFAULT_FLOW_PROPS with localStorage "graph-flow-props"),
  `settingsOpen`, `layoutMode` ('dagre-lr' default) + a `layoutModeRef` so
  `syncNodes` reads it without dep churn, `dataset` ('137CS').
- The `<ReactFlow>` props block is at src/pages/GraphPage.tsx:1002-1021
  (onNodesChange at 1005; fitView/proOptions/nodesConnectable/minZoom at
  1018-1021). Replace the hardcoded minZoom/nodesConnectable with the full
  flowProps spread (colorMode, selectionMode, selectNodesOnDrag, elevate*,
  paneClickDistance, preventScrolling, selectionOnDrag, panOnDrag/Scroll/
  Speed/Mode, zoomOn*, nodesDraggable, nodeDragThreshold, nodesConnectable,
  elementsSelectable, autoPan*, minZoom, maxZoom, onlyRenderVisibleElements,
  snapToGrid, snapGrid={[x,y]}, connectionMode, connectionRadius,
  connectionLineType, connectOnClick, nodesFocusable, edgesFocusable,
  deleteKeyCode, selectionKeyCode, multiSelectionKeyCode,
  zoomActivationKeyCode, panActivationKeyCode).
- ADD `onNodesDelete={(del) => del.forEach((n) => removeNode(n.id))}` — RF
  keyboard delete must sync our store or the canvas desyncs.
- `layout()` gets a rankdir param; `syncNodes(all, relayout)`: if
  layoutModeRef==='none' skip dagre — place NEW nodes (no prevPos) next to
  their edge-source (+320 x, stacked y). Mode change → relayout + fitView.
- Datasets (panel "Nodes & Edges"): 137CS nuclide / 235U nuclide / (N,G)
  reaction / 2011CH57 paper / empty (clears store+edges+nodes). onDataset →
  center(...) accordingly.
- Settings pill: Settings2 icon-only pill appended to the top-right group
  (same style as History). Panel render: `{settingsOpen ? <FlowSettingsPanel/>
  : (existing trace/edge/sel branches)}` — guard the other three with
  !settingsOpen.

## 2. Similarity edges (small, embeddings are live)

- api/graph.ts: `op=similar&id=KEY` → `SELECT e2.key_number, 1 - (e1.embedding
  <=> e2.embedding) AS cos FROM nsr_embeddings e1 JOIN nsr_embeddings e2 ON
  e2.key_number <> e1.key_number WHERE e1.key_number = $1 ORDER BY
  e1.embedding <=> e2.embedding` — WRONG SHAPE, use the fast form: fetch
  e1.embedding first, then `ORDER BY embedding <=> $vec LIMIT 6` (kNN uses the
  HNSW index only with a constant query vector). Join nsr for PAPER_COLS.
- Paper cards get a "similar" affordance (chip next to +EXFOR). Edges from
  similarity are INFERENCES: dashed (`strokeDasharray: "6 3"`), label
  `${cos.toFixed(2)} cos`, and edgeReceipt() says plainly: "Inference from the
  embedding space (bge-m3 cosine similarity) — NOT a database record." Never
  style them like record edges (44b invariant).

## 3. Chat-dock overhaul (Brendan's #83-#85)

- Replace ChatDock's hand-rolled input with the canonical
  `src/components/ChatInput.tsx` (model picker + PlusMenu; onSubmit(message,
  modelId) — pass modelId through to /api/chat body).
- Drag a canvas node into the dock: canvas nodes set
  `dataTransfer("application/nsr-entity", JSON.stringify(gnode))` on
  dragstart (RF nodes need an explicit draggable ghost — simplest: the detail
  panel header and rail rows are draggable; for canvas cards use onDragStart
  on the card div with draggable). While dragging over the dock show a blue
  dashed border ("border-2 border-dashed border-blue-400") drop target.
- Dropped entity becomes ACTIVE CONTEXT: an attached banner above the input
  (Claude-code style: small bar tucked behind the input container, rounded-t,
  entity label + X to clear). Its data is prepended to systemContext.

## 4. Canvas ergonomics batch

- Undo/redo ⌘Z/⌘⇧Z/⌘Y: snapshot {store entries, edges, expandState} on every
  mutating op (addNodes/removeNode/center/onConnect), history ≤50, skip when
  document.activeElement is input/textarea (44b canvas-state.ts is the
  reference — port its reducer shape).
- Paper-card accordions: NUCLIDES/AUTHORS groups collapsed by default —
  GNode.openGroups?: string[]; header click → patchNode + relayout;
  nodeHeight() counts rows ONLY for open groups (dagre must see the truth).
- Rail rows + search suggestions draggable onto the canvas (same
  application/nsr-entity payload; canvas onDrop: check entity payload BEFORE
  file branch, addNodes at drop position without recentering).
- Hover ⋮ menu on rail rows (Claude-chat style): Center on canvas / Add to
  canvas / Ask in chat (sets the dock's active-context entity).
- Toolbar pills smaller: Brendan says current ones are too big — search inner
  h-8, action pills h-8 px-3.5 text-[13px] (his devtools edit was smaller).
- Search dropdown lazy-load: page the "Most studied" list from
  /data/catalog.json top lists (~15 at a time) as the user scrolls
  (onScroll near-bottom → append next slice).
- Rail: split "Views & recipes" into two entries (Views / Recipes — a saved
  state is a recipe iff it contains prompt nodes); browsing lists them via
  /api/community?tab=views and clicking LOADS onto the canvas (existing
  ?view= loader logic) — nothing on /graph navigates away. Same rule for the
  detail panel's "Open mass chain": on /graph it should expand papers on the
  canvas (pass an onCanvas callback into DetailBody), with a small external
  link as secondary.

## 5. After the canvas: model phase lanes

- Write LANE-EVAL (Stage 1: frozen benchmark from keyword→paper + EXFOR→paper
  judgments; baselines FTS vs raw bge-m3 vs one commercial embedding;
  Recall@k/nDCG) and LANE-TRIPLETS (Stage 2: queries from the 196k keyword
  abstracts, positives from annotation links, hard negatives from
  nsr_embeddings kNN). Both follow the LANE-EMBED format: measured anchors
  only, objective gates, do-not-commit, REPORT section. Credits are money.

House rules: NUL-check every generated file; typecheck + vite build before
every commit; commit per chunk; never quote unmeasured numbers; the toolbar
design is Brendan's — match his mocks exactly or ask for outerHTML.
