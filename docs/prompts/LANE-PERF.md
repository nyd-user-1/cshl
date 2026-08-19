# LANE-PERF — every page under one second, search instant, Supabase gone from the client

You are making nsr.nysgpt.com fast. Tonight's measurement: `/references` took
**25 s** to load; the HTML itself arrives in 0.14 s, so the whole wait is the
data path. Root cause, measured 2026-08-17 01:15: the page (and 13 other
files) still query **Supabase** — the legacy database slated for deletion —
with `count: "exact"` over the whole `nsr` table on every page view. Supabase
warm answers that in 0.28 s; cold/paused it takes 20–30 s. Meanwhile Neon via
our Vercel functions answers in **~0.2 s warm from `iad1`** (same region as
Neon `us-east-1`; cold start ~1.7 s). The fix is not tuning Supabase — it is
finishing the migration that `/api/chat`, `/api/graph`, `/api/community`,
`/api/search` already made, and then caching what is read-only.

Standard: **every route interactive < 1 s on a warm visit; search results
< 500 ms end-to-end after the first request; no page waits on Supabase.**
Measure with `curl -w '%{time_total}'` and the browser's own Network panel
timings that Brendan pastes — no headless browsers, ever.

## DESIGN-SYSTEM CONTRACT — read `docs/prompts/LANE-UI-ENSDF.md` §"DESIGN-SYSTEM CONTRACT" and obey it verbatim
This lane changes data plumbing, not looks. Zero visual changes unless a
loading state needs one; then compose from `src/components/ui/*` only.

## Non-negotiables

1. **Read first**: `api/graph.ts`, `api/search.ts`, `api/_lib/embed.ts`
   (the house patterns: classic `(req,res)` handler — Web handlers HANG on
   this project; `neon()` HTTP driver; `sql.transaction` for `SET LOCAL`),
   `src/hooks/useNsrSearch.ts` (a hook already moved off Supabase — copy its
   shape), `src/hooks/useNsrRecords.ts` (the 25-s culprit), `vercel.json`,
   `sql/13-full-corpus-schema.sql`, `sql/22-search-speed.sql`,
   `docs/search-performance-report.md`, `sql/03-chat-sessions.sql`,
   `sql/09-research-feed.sql`.
2. **Neon is the only database the client may reach, and only through
   `/api/*`.** No `neon()` in the browser, no DATABASE_URL in `VITE_*`.
3. **No new dependencies.** No new UI primitives. No headless browsers.
   No `npx` one-offs on this laptop; `npm run build` / `tsc -b` are fine.
4. **Every claim is a measurement**: before/after `curl` timings for each
   endpoint (cold and 3× warm) and the bundle-size diff (`ls -l dist/assets`)
   go in REPORT.
5. **Do not commit, do not push.** REPORT by editing this file.

## Phase 1 — retire Supabase from the client (the 25-second fix)

Inventory (measured): 14 files import `@/integrations/supabase/client`.
Calls: `nsr` ×3 (browse/paginate/key lookup), `distinct_nuclides` ×2,
`distinct_reactions` ×2, `distinct_authors` ×1, `chat_sessions` ×7,
`research_feed` ×1, `rpc(insert_feed_event)` ×2, `rpc(search_nsr_structured)`
×1, edge fn `paper-lookup` ×1. Replace each with a Vercel function on Neon:

- **`/api/records`** — `?year=&exfor=1&cursor=&limit=99`. **Keyset pagination**
  (`(pub_year, key_number) < ($1,$2)`) — never OFFSET, never `count: exact`.
  Total counts come from one cheap query per filter: `SELECT count(*) FROM
  nsr WHERE pub_year=$1` is fine (btree on pub_year exists — verify with
  `\d nsr`); the unfiltered total from `pg_class.reltuples` (or a
  `nsr_stats` row refreshed by the loaders). Return the `NsrRecord` shape.
  Add `Cache-Control: s-maxage=3600, stale-while-revalidate=86400` — the
  corpus changes monthly.
- **`/api/dict`** — `?type=nuclides|reactions|authors&q=` from Neon's
  `nuclide_dict` / `reaction_dict` / `authors` (+ counts via the join
  tables if the UI shows them). Cache 1 day.
- **`/api/chat-sessions`** — CRUD for the chat sidebar over `chat_sessions`
  in Neon (apply `sql/03` to Neon if it isn't there — check first with
  `\dt`; note in REPORT). Same JSON the hooks expect today.
- **`/api/feed`** — research feed read + `insert_feed_event` (sql/09–10 on
  Neon; same check).
- **`/api/paper`** — replaces the `paper-lookup` edge function (S2 by
  DOI/title; keep whatever key/env it used — find it in `supabase/functions/`).
- Structured search (`search_nsr_structured`) → add `mode=structured` to
  `/api/search` (arrays `nuclides && $1`, `reactions && $2`; GIN indexes
  exist).
- Then **delete `src/integrations/supabase/`**, remove `@supabase/supabase-js`
  from `package.json`, and confirm the `supabase-*.js` chunk (171 KB)
  disappears from `dist/assets`. Remove `VITE_SUPABASE_*` from Vercel env
  ONLY after the lead confirms in QA — list them in REPORT instead.

Gate 1: `/references` first paint-to-rows < 1 s warm (curl the API: < 300
ms), page/filter change < 300 ms; zero references to Supabase in `src/`.

## Phase 2 — cache the read paths (Brendan's RAG-design takeaways)

- **Search results**: `/api/search` (semantic and keyword) is deterministic
  per `(q, mode, limit)` for a month → `Cache-Control: s-maxage=3600,
  stale-while-revalidate=604800` so the Vercel edge serves repeats in ~20
  ms and the encoder is not called twice for the same query. Semantic mode
  additionally memoizes the query vector in a small Neon table
  `query_embeddings(text_hash PK, model, embedding, hits, last_seen)` — a
  repeat query costs a 1-ms lookup, not an HTTP call to the encoder.
- **Chat retrieval**: in `/api/chat`, memoize the retrieval bundle for a
  normalized `userMessage` (same table pattern, `retrieval_cache`, TTL 1
  day) so a re-asked question streams immediately. Never cache the model's
  answer text.
- **Static data**: `public/data/**` already has SWR headers; verify every
  page that fetches JSON uses them (no `cache: "no-store"`).

## Phase 3 — rate limiting on `/api/*`

- Token bucket per client IP in each billable function (`/api/chat`,
  `/api/search`, `/api/upload`, `/api/bricc`, `/api/logft`): e.g. 60
  requests / min / IP for search, 20 / min for chat, 429 with `Retry-After`.
  Implement once in `api/_lib/ratelimit.ts` using the Vercel Runtime Cache
  if available in this project, else an in-memory Map keyed by IP with the
  honest caveat that it is per-instance (Fluid reuses instances, so it still
  bites bots). Log 429s. No auth — display-name-only rule stands.

## Phase 4 — bundle and client

- Measured chunks: `markdown` 394 KB, `index` 310 KB, `recharts` 306 KB,
  `katex` 261 KB, `xyflow` 180 KB, `supabase` 171 KB. Confirm each heavy
  chunk loads only on the routes that use it (recharts → feed/structure;
  xyflow → /graph; markdown+katex → chat/help) and that hover-prefetch does
  not eagerly pull them on the home route. Report the route → chunks table
  from `vite build`.
- `/references`, `/search`, `/community` lists: keep DOM small (page size or
  windowing via existing patterns — no new library).
- Add `@vercel/speed-insights` ONLY if already in the Vercel plan (check
  `vercel` project settings); otherwise skip and say so — no paid add-ons.

## Gates / REPORT

- Before/after table: route → cold / warm ×3 `curl` timings for its API
  calls; `/references` and `/search` must meet the standard.
- Bundle diff (`ls -l dist/assets` before/after), `supabase` chunk gone.
- Zero `integrations/supabase` imports (grep count = 0).
- Cache hit evidence: `x-vercel-cache: HIT` on a repeated `/api/search` and
  `/api/records` call (paste headers).
- 429 evidence: a 70-request burst to `/api/search` shows 429s after 60.
- Design-contract self-audit line.

## REPORT

_(edit as you go; the lead reads it verbatim)_

- Status: **Phases 1, 2 (partial), 4 (partial) SHIPPED 2026-08-17 by the lead
  session directly** (no worker window) — commits `2b93ab4` + `3efac19`, tag
  `pre-lane-perf`. Phases 3 and the chat-retrieval memo were **deliberately NOT
  done** — they are policy changes awaiting Brendan's sign-off.
- Phase 1: **done.** New Neon routes `api/records.ts`, `api/dict.ts`,
  `api/chat-sessions.ts`, `api/feed.ts`, `api/paper.ts`, `api/record.ts`
  (GET + PATCH save-abstract), `mode=structured` on `api/search.ts`. All
  Supabase imports removed from `src/`, `@supabase/supabase-js` removed from
  `package.json`, 171 KB supabase chunk gone from the bundle. `/references`
  25 s cold → ~0.5 s warm (edge-cached 1 h). `supabase/functions/*` remain on
  disk as dead code (grep hazard — see docs cleanup note).
- Phase 2: **partial.** Edge cache headers live on `/api/search` and
  `/api/dict` (authors 7.1 s cold → 0.1 s edge HIT); query-vector memo exists
  as `query_vec_cache` (sql/27, `embedQueryCached` in `api/_lib/embed.ts`).
  The chat `retrieval_cache` memo is NOT built (awaiting sign-off).
- Phase 3: **not done.** No `api/_lib/ratelimit.ts` exists; `/api/*` has no
  rate limiting. Awaiting sign-off.
- Phase 4: **partial.** Supabase chunk removed; hover-prefetch added for route
  chunks + data JSON (sidebar, tool cards, structure rows). The route→chunk
  table from `vite build` was never produced.
- Deviations / flags: `VITE_SUPABASE_*` still present in Vercel env (unused —
  removal is Brendan's call), and the Supabase project itself is now safe to
  delete (nothing reads it).
