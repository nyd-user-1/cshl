# LANE-GRAPH-CSHL — bring /graph back for the preprint corpus

Append-only, timestamped (UTC). Fence: `src/pages/GraphPage.tsx`, `src/components/ChatDock.tsx`,
`src/components/EntityDetail.tsx`, `src/components/FlowSettings.tsx`, `src/lib/drag-entity.ts`,
NEW `api/graph.ts`, `src/App.tsx` (route + lazy import only), `src/components/Sidebar.tsx`
(nav entry only). **Not** this lane's: any other `src/pages/*`, training, schema changes.
Laptop rule: typecheck/build fine; DB access read-only via `DATABASE_URL` in `.env.local`.

## The situation

`/graph` is the ReactFlow workspace canvas from the NSR era: 1,727 lines, currently
UNROUTED and non-functional here because **`/api/graph` does not exist in this repo** —
the backend stayed behind in the NSR codebase. The canvas machinery (prompt nodes, file
nodes, ChatDock, FlowSettings, drag-to-canvas) is domain-agnostic and good; the entity
model (paper | author | nuclide | reaction | exfor) and every seed/citation/evidence string
is nuclear. Brendan's call (2026-08-21): **/graph is definitely kept — converted to the
CSHL corpus.** And per the standing rule, conversion means making the page's domain-specific
parts data-driven where practical: the next flip (tariffs/chemistry) should mostly edit an
entity-config, not 1,700 lines.

## Design constraints (settled, don't relitigate)

- **Entity model:** `paper | author | category | prompt | file | more`. Nuclides/reactions/
  exfor are gone; `category` (author-assigned, 76 values — same vocabulary `/api/dict`
  serves) takes the chip slot `nuclides` had. Keep the `prompt`/`file`/`more` canvas types
  untouched.
- **Edges:** authorship (preprint_authors), category annotation, and **similarity via
  cshl-CITE kNN** — the `op=similar` design from the NSR era is already reimplemented at
  `api/similar.ts`; reuse its query shape and its encoder conventions. Citation edges only
  if the schema actually has them — check, don't assume.
- **`api/graph.ts`:** ops `node`, `expand`, `search`, `similar`. `src/pages/Chat.tsx`
  already calls `/api/graph?op=node&type=…&id=…` for the entity side panel (it 404s today) —
  keep that contract so Chat's panel starts working the moment the endpoint exists.
- **Vercel function count — CHECK BEFORE CODING.** `api/` holds 12 function files on main;
  the Hobby plan caps at 12, and `lane/bedrock-kb` adds `kb-rag.ts` when it merges. Count
  what the plan allows (`vercel project` / plan docs). If over the cap, fold `api/similar.ts`
  into `api/graph.ts` as `op=similar` and leave a rewrite or update the callers
  (`grep -rn "api/similar" src`) — do NOT silently drop an endpoint.
- **Seeds and starter queries** (the canned entities on the empty canvas) must be REAL rows
  queried from the DB (top-cited / most-similar-dense preprints, prolific authors, biggest
  categories), written into the entity-config with their true counts. No invented key numbers.
- `EntityDetail`'s NSR fields (`is_nsr` badge, "NNDC NSR dump", "NSR entry date") get
  replaced by the preprint record's real fields (server, posted date, published journal…).
- `ChatDock`'s system prompt: RxivGPT voice, cite bioRxiv/medRxiv key numbers — mirror the
  grounding rules used in `api/chat.ts` rather than inventing new ones.
- Route `/graph` in `App.tsx` (lazy import, same pattern as the others) and add the
  Workspace nav entry in `Sidebar.tsx`.

## Verification

- `npx tsc -b` and `npm run build` clean per milestone. **`npx tsc -b` does NOT check
  `api/` — a Vercel preview deploy is the only typecheck `api/graph.ts` gets. Deploy a
  preview and hit every op with `vercel curl` before calling the endpoint done**, with the
  outputs in the log.
- Click-through: seed → expand author → expand similar → drag to chat dock → ask a question
  with a citation chip. Record what actually happened, including what is broken.
- Preview URL in the log; Brendan promotes to prod himself.

## Status reporting

Dated log entries at lane start (state read before touching), per milestone (backend live /
entity model swapped / routed + nav), and a closing entry with the click-through record.
Claims carry commands + output, not summaries.

---

## Log

(append here)
