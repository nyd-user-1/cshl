 > **⚠️ Historical snapshot (February 2026).** Describes the Supabase-era build: record counts ("88,000+"), GPT-4o chat, and the regex nuclide parser are all superseded. Current ground truth: `docs/data-accounting.md` (full 255k corpus in Neon, chat on AWS Bedrock, selectors from the NNDC relational dump).

# NSRgpt — Full Architecture Report

> Use this document as a prompt to bootstrap a new SPA with the same architecture but connected to a different Supabase project and domain (e.g. sports, finance, legal).

---

## Quick Stats

| Metric | Value |
|---|---|
| Repo size (source only) | ~864 KB |
| Source files (.tsx/.ts/.css) | 61 |
| Lines of code | 7,936 |
| Components | 30 |
| Pages | 7 |
| Custom hooks | 13 |
| UI primitives (shadcn-style) | 10 |
| Edge functions (Deno) | 7 |
| SQL schema files | 11 |
| Utility scripts | 11 |
| Public assets | 5 |
| Largest file | References.tsx (706 lines) |

---

## Tech Stack

### Frontend
- **React 19.2** + **TypeScript 5.9**
- **Vite 7.3** (build + dev server)
- **React Router 7.13** (client-side routing)
- **TanStack React Query 5.90** (server state / caching)
- **TailwindCSS 4.2** (utility-first styling, custom theme with CSS variables)
- **Recharts 3.7** (bar charts, data viz)
- **Lucide React 0.575** (icon library)
- **Radix UI** (dialog, popover, tabs — headless primitives)
- **react-markdown 10.1** (markdown rendering in chat)
- **sonner 2.0** (toast notifications)
- **vaul 1.1** (mobile drawer)

### Backend
- **Supabase** (PostgreSQL + pgvector + Realtime + Auth + Edge Functions)
- **Deno Edge Functions** (7 functions for AI, search, enrichment)
- **OpenAI API** (text-embedding-3-small for 256-dim embeddings, GPT-4o for chat)
- **Semantic Scholar API** (external paper enrichment)

### Deployment
- **Vercel** (frontend hosting, auto-deploy from GitHub)
- **Supabase** (managed Postgres, edge function hosting)

---

## Directory Structure

```
bnlgpt/
├── index.html                          # Entry HTML (viewport meta, title)
├── package.json                        # Dependencies & scripts
├── vite.config.ts                      # Vite config with React + Tailwind plugins
├── tsconfig.json                       # TypeScript config (strict, @/ alias)
├── vercel.json                         # Vercel SPA rewrites
├── public/
│   ├── cshl-logo.png                  # App logo
│   ├── openai-logo.avif               # Model selector icon
│   ├── claude-logo.avif               # Model selector icon
│   └── vite.svg
├── src/
│   ├── main.tsx                        # React root mount
│   ├── App.tsx                         # Router + providers
│   ├── index.css                       # Tailwind + custom theme (light + dark)
│   ├── lib/utils.ts                    # cn() class merge utility
│   ├── layouts/
│   │   └── AppLayout.tsx               # Shell: sidebar + top bar + feed + disclaimer
│   ├── pages/                          # 7 route pages
│   ├── components/                     # 20 app components + 10 UI primitives
│   ├── hooks/                          # 13 custom hooks
│   ├── types/                          # 3 type definition files
│   └── integrations/supabase/          # Supabase client + generated types
├── supabase/
│   ├── functions/                      # 7 Deno edge functions
│   └── migrations/                     # Performance optimization migrations
├── sql/                                # 11 schema/RPC definition files
├── scripts/                            # 11 data loading/enrichment scripts
└── docs/                               # This report
```

---

## Pages (7)

| Route | File | Lines | Purpose |
|---|---|---|---|
| `/` , `/new-chat` , `/c/:sessionId` | Chat.tsx | 149 | Conversational AI with streaming, session persistence, auto-scroll |
| `/references` | References.tsx | 706 | Full NSR record browser with semantic/keyword search, nuclide/reaction/Z-range filters, pagination (99/page) |
| `/search` | Search.tsx | 569 | Faceted search with stat widgets (year chart, journal/nuclide/reaction breakdowns), client-side filtering |
| `/endf` | Endf.tsx | 395 | ENDF technical report browser with search, date filters, inline PDF viewer |
| `/features` | Features.tsx | 403 | Side-by-side comparison table (NNDC NSR vs NSRgpt) |
| `/resources` | Resources.tsx | 123 | Curated external links (X4Pro, EXFOR, EMPIRE, ENDF libraries, GRUCON) |
| `/` (unused) | Home.tsx | 82 | Landing page stub with search + browse tabs |

---

## Components (30)

### App Components (20 files)

| Component | Lines | Purpose |
|---|---|---|
| **PlusMenu.tsx** | 489 | "+" button with category drawers (sample prompts, nuclides, reactions, authors). Fetches from Supabase views with search + infinite scroll. `mode="chat"\|"search"` prop controls output text. |
| **RecordDrawer.tsx** | 345 | Slide-up detail drawer for a single NSR record. Shows full metadata, nuclides, reactions, keywords, DOI link, note-taking textarea. Prev/next navigation. |
| **ChatResponseFooter.tsx** | 313 | Expandable source citations panel beneath AI responses. Shows NSR records + Semantic Scholar papers with similarity scores. |
| **Sidebar.tsx** | 294 | Navigation sidebar: app title, nav links (References, ENDF, Search, New Chat), collapsible "Your Chats" list with rename/delete context menus, UserMenu at bottom. |
| **NsrRecordCard.tsx** | 235 | Grid card for an NSR record: key_number, title, authors, year, DOI, keywords, nuclides/reactions tags, "Ask NSRgpt" button. |
| **SearchInput.tsx** | 233 | Two exports: `SearchInput` (simple text input with icon) and `SearchBox` (textarea + mode selector + PlusMenu + submit button). Mode selector flips direction based on viewport position. |
| **NuclideCombobox.tsx** | 200 | Autocomplete filter for nuclides. Fetches from `distinct_nuclides` view, debounced search, renders as popover with scrollable list. |
| **ReactionCombobox.tsx** | 193 | Same pattern as NuclideCombobox but for reactions (e.g. "(n,p)", "(d,a)"). |
| **ChatInput.tsx** | 189 | Chat textarea with model selector dropdown (visual only — always GPT-4o), PlusMenu integration, send/stop button. Auto-resize. |
| **EndfReportCard.tsx** | 170 | Card for ENDF report: title, report number, date, authors, PDF download link. |
| **UserMenu.tsx** | 131 | Bottom-of-sidebar user menu: Upgrade (stub), Settings (stub), Features (navigates to /features), Theme (light/dark submenu), Log out (stub). |
| **ChatMessage.tsx** | 93 | Renders a single chat bubble. User messages are plain text; assistant messages render markdown via react-markdown. |
| **ElementRangeCombobox.tsx** | 94 | Z-range (atomic number) filter selector. |
| **MobileFilterDrawer.tsx** | 32 | Wrapper around vaul Drawer for mobile filter UI. |
| **Header.tsx** | 13 | Minimal header stub. |

### ResearchFeed (5 files)

| Component | Purpose |
|---|---|
| **ResearchFeed.tsx** | Collapsible right-side panel showing real-time user activity feed. |
| **FeedHeader.tsx** | Feed panel header with title and close button. |
| **FeedItem.tsx** | Single feed event: search query, nuclide lookup, chat started, etc. Clickable to navigate. |
| **TrendingStrip.tsx** | Horizontal scrollable strip of trending nuclides/topics. |
| **index.ts** | Barrel re-export. |

### Icons (1 file)

| Component | Purpose |
|---|---|
| **icons/TextSearch.tsx** | Custom SVG icon for text/keyword search mode. |

### UI Primitives (10 files, shadcn-style)

| Primitive | Based On | Purpose |
|---|---|---|
| **button.tsx** | CVA | Button with variants: default, destructive, outline, secondary, ghost, link. Sizes: default, sm, lg, icon. |
| **badge.tsx** | CVA | Inline label. Variants: default, secondary, destructive, outline. |
| **card.tsx** | div | Card container with CardHeader, CardTitle, CardDescription, CardContent, CardFooter slots. |
| **input.tsx** | input | Styled text input. |
| **skeleton.tsx** | div | Loading placeholder with pulse animation. |
| **popover.tsx** | Radix Popover | Floating content panel. |
| **tabs.tsx** | Radix Tabs | Tab list + tab content panels. |
| **sheet.tsx** | Radix Dialog | Side panel overlay (left/right/top/bottom). |
| **drawer.tsx** | vaul | Mobile-optimized bottom drawer. |
| **chart.tsx** | Recharts | Chart container with tooltip/legend configuration. |

---

## Hooks (13)

| Hook | Lines | Purpose |
|---|---|---|
| **useChat.ts** | 281 | Core chat engine. Streams SSE from `/functions/v1/chat`, extracts sources JSON, manages message array, handles abort. |
| **useNsrSearch.ts** | 257 | Search engine. Semantic mode calls `semantic-search-nsr` edge function; keyword mode does ILIKE + `search_nsr_structured` RPC in parallel. 10-item LRU cache. Performance metrics logging. |
| **useChatPersistence.ts** | 89 | CRUD for `chat_sessions` table. Auto-saves messages after each AI response. |
| **useEndfReports.ts** | 75 | Fetches ENDF reports with title search, date range filter, sort options. |
| **useResearchFeed.ts** | 71 | Subscribes to `research_feed` table via Supabase Realtime. Returns latest 50 events. |
| **useNsrRecords.ts** | 50 | Paginated browse of NSR records (newest first). |
| **useS2Enrichment.ts** | 48 | Triggers Semantic Scholar enrichment for a record via `enrich-s2` edge function. |
| **usePaperLookup.ts** | 43 | Single paper lookup by DOI via `paper-lookup` edge function. |
| **useNsrStructuredSearch.ts** | 41 | Structured search RPC: filter by nuclides[], reactions[], z_min/z_max, year range. |
| **useTheme.tsx** | 40 | React context for dark/light theme. Persists to localStorage. Applies `.dark` class to `<html>`. |
| **useFeedEmitter.ts** | 32 | Emits activity events (search, filter, chat) to `research_feed` via `insert_feed_event` RPC. |
| **useChatSessions.ts** | 30 | Lists all chat sessions for the current user, ordered by last updated. |
| **useDebouncedValue.ts** | 13 | Generic debounce hook (configurable delay, default 320ms). |

---

## Types (3 files)

### nsr.ts (36 lines)
```ts
interface NsrRecord {
  id: number;
  key_number: string;
  pub_year: number;
  reference: string | null;
  authors: string | null;
  title: string;
  doi: string | null;
  exfor_keys: string | null;
  keywords: string | null;
  nuclides?: string[] | null;
  reactions?: string[] | null;
  similarity?: number;
  // S2 enrichment fields
  s2_paper_id?: string | null;
  citation_count?: number | null;
  influential_citation_count?: number | null;
  abstract?: string | null;
  tldr?: string | null;
  venue?: string | null;
  is_open_access?: boolean;
  open_access_pdf_url?: string | null;
  fields_of_study?: string[] | null;
  s2_authors?: S2Author[] | null;
  // ... more fields
}
```

### feed.ts (20 lines)
```ts
interface FeedEvent {
  id: string;
  event_type: string;
  category: string;
  entity_type: string;
  entity_value: string;
  display_text: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
```

### endf.ts (9 lines)
```ts
interface EndfReport {
  id: number;
  seq_number: number;
  report_number: string;
  authors: string | null;
  title: string;
  report_date: string | null;
  pdf_url: string | null;
}
```

---

## Supabase Edge Functions (7)

| Function | File | Purpose |
|---|---|---|
| **chat** | `supabase/functions/chat/index.ts` | RAG pipeline: extract nuclides/reactions/authors from query → embed via OpenAI → fetch NSR records (semantic + structured + author search in parallel) → fetch Semantic Scholar papers → build grounded system prompt → stream GPT-4o response via SSE. |
| **semantic-search-nsr** | `supabase/functions/semantic-search-nsr/index.ts` | Embed query → call `search_nsr_hybrid` RPC (text pre-filter + semantic rerank) → return ranked results with timing metrics. 30-min embedding cache. Falls back to `match_nsr_records` on error. |
| **enrich-s2** | `supabase/functions/enrich-s2/index.ts` | Batch lookup NSR records on Semantic Scholar by DOI. Writes citation_count, abstract, tldr, venue, is_open_access, etc. back to nsr table. |
| **enrich-s2-search** | `supabase/functions/enrich-s2-search/index.ts` | Full-text search on Semantic Scholar API for records without DOI. |
| **paper-lookup** | `supabase/functions/paper-lookup/index.ts` | Single paper detail lookup by DOI from Semantic Scholar. Returns full metadata. |
| **compute-insights** | `supabase/functions/compute-insights/index.ts` | Aggregates research_feed events into trending nuclides / high-impact papers. Triggered by pg_cron every 15 minutes. |
| **enrich-elsevier** | `supabase/functions/enrich-elsevier/index.ts` | Elsevier/Scopus API enrichment for additional metadata. |

---

## Database Schema (11 SQL files)

### Tables

| Table | Key Columns | Purpose |
|---|---|---|
| **nsr** | id, key_number (UNIQUE), pub_year, reference, authors, title, doi, exfor_keys, keywords, embedding vector(256), nuclides[], reactions[], z_values[], s2_* fields | Core NSR records (88,000+) with vector embeddings |
| **chat_sessions** | id (UUID), title, messages (JSONB[]), user_id, created_at, updated_at | Persistent chat conversations |
| **exfor_entries** | exfor_id, title, targets[], processes[], observables[], facility | EXFOR experimental data cross-references |
| **endf_reports** | seq_number, report_number, authors, title, report_date, pdf_url | 300+ ENDF technical reports |
| **research_feed** | id, event_type, category, entity_type, entity_value, display_text, metadata, created_at | Real-time activity feed with 60s dedup |

### RPC Functions

| Function | Parameters | Returns |
|---|---|---|
| **match_nsr_records** | query_embedding, match_threshold, match_count, filter_year | Records ranked by cosine similarity |
| **search_nsr_hybrid** | query_text, query_embedding, match_threshold, match_count, filter_year, prefilter_count | Hybrid: text pre-filter → semantic rerank with timing |
| **search_nsr_structured** | p_nuclides, p_reactions, p_z_min, p_z_max, p_year_min, p_year_max, p_limit | Structured filter using array overlap (&&) operator |
| **insert_feed_event** | p_event_type, p_category, p_entity_type, p_entity_value, p_display_text, p_metadata | Insert with 60-second deduplication |
| **compute_feed_insights** | (none) | Aggregates trending data, writes insight events |

### Indexes

- **HNSW** index on `nsr.embedding` for approximate nearest neighbor search
- **IVFFlat** index for exact vector search (fallback)
- **GIN** indexes on `nuclides`, `reactions` arrays
- **B-tree** indexes on `key_number`, `pub_year`, `doi`

### Views

- **distinct_nuclides** — unique nuclides with record counts
- **distinct_reactions** — unique reactions with record counts
- **distinct_authors** — unique authors with record counts

---

## Styling System

### Theme Architecture
- **CSS variables** defined in `index.css` using oklch color space (light) and hex (dark)
- **Two themes**: Light (default) + Dark (Bloomberg terminal–inspired: amber-on-black)
- **Custom color tokens**: `--color-nuclear` (blue accent for interactive elements), `--color-muted`, `--color-foreground`, etc.
- **Global rules**: 16px min font on mobile inputs (prevents iOS zoom), thin scrollbars, cursor pointer on interactive elements
- **Dynamic viewport**: `h-dvh` for proper iOS Safari toolbar handling

### Key CSS Classes (custom, beyond Tailwind defaults)
- `.dark` — Bloomberg-inspired dark theme
- Scrollbar styling (6px width, pill thumb)
- iOS zoom prevention (`@media max-width:767px` → 16px inputs)

---

## Data Flow Patterns

### Search Flow
```
User types query
  → useDebouncedValue (320ms)
  → useNsrSearch checks mode
    → semantic: POST /functions/v1/semantic-search-nsr
      → Edge function: embed query → search_nsr_hybrid RPC → return ranked results
    → keyword: Supabase REST .or() ILIKE + search_nsr_structured RPC in parallel
      → Merge & deduplicate results
  → In-memory LRU cache (10 entries, 30min stale time)
  → React Query manages loading/error/data states
  → Page renders results + stat widgets
```

### Chat Flow
```
User sends message
  → useChat sends POST /functions/v1/chat with SSE streaming
  → Edge function:
    1. Extract nuclides, reactions, author names from message
    2. Embed message via OpenAI (text-embedding-3-small, 256d)
    3. Parallel fetch: semantic NSR + structured NSR + author NSR + Semantic Scholar
    4. Merge & deduplicate (structured first, then semantic)
    5. Build system prompt with grounding context
    6. Stream GPT-4o completion back via SSE
  → Frontend parses SSE: first event = sources JSON, rest = token stream
  → useChatPersistence saves to chat_sessions table
  → useFeedEmitter logs to research_feed
```

### Feed Flow
```
Any user action (search, filter, chat)
  → useFeedEmitter calls insert_feed_event RPC (60s dedup)
  → research_feed table INSERT triggers Supabase Realtime
  → useResearchFeed subscription receives event
  → ResearchFeed panel updates in real-time
  → compute_feed_insights (pg_cron, every 15min) aggregates trending data
```

---

## Routing

```tsx
<Routes>
  <Route element={<AppLayout />}>          // Shared shell: sidebar + top bar + feed
    <Route path="/" element={<Chat />} />
    <Route path="/new-chat" element={<Chat />} />
    <Route path="/c/:sessionId" element={<Chat />} />
    <Route path="/references" element={<References />} />
    <Route path="/resources" element={<Resources />} />
    <Route path="/endf" element={<Endf />} />
    <Route path="/search" element={<Search />} />
    <Route path="/features" element={<Features />} />
  </Route>
</Routes>
```

---

## Scripts (11)

| Script | Language | Purpose |
|---|---|---|
| embed-nsr.py | Python | Batch-compute OpenAI embeddings for all NSR records, write to Supabase |
| embed-nsr.mjs | Node.js | JavaScript alternative for embedding computation |
| load-csv.mjs | Node.js | Bulk load NSR records from CSV into Supabase |
| load-nsr-json.py | Python | Load NSR records from JSON export |
| load-exfor.py | Python | Load EXFOR experimental data |
| parse-keywords.py | Python | Extract nuclides/reactions from title/keyword fields via regex |
| scrape-endf-reports.py | Python | Scrape ENDF report listing from web |
| standardize-endf-dates.sql | SQL | Normalize date formats in endf_reports |
| enrich-elsevier.sh | Shell | Trigger Elsevier API enrichment |
| enrich-s2.sh | Shell | Trigger Semantic Scholar batch enrichment |
| endf-reports.json | JSON | Pre-parsed ENDF report metadata (data file) |

---

## How to Recreate This for a Different Domain

### What to keep as-is (the "framework"):
1. **AppLayout.tsx** — sidebar + top bar + feed panel + disclaimer modal
2. **Sidebar.tsx** — navigation + chat sessions (rename structure for your domain)
3. **UserMenu.tsx** — theme toggle, settings, features link
4. **ChatInput.tsx** / **ChatMessage.tsx** / **ChatResponseFooter.tsx** — full chat system
5. **SearchInput.tsx** / **SearchBox** — search UI with mode selector
6. **PlusMenu.tsx** — category drawer system (swap categories for your domain)
7. **RecordDrawer.tsx** — detail view pattern (swap fields for your domain)
8. **All hooks** — useChat, useChatPersistence, useChatSessions, useTheme, useDebouncedValue, useFeedEmitter, useResearchFeed
9. **All UI primitives** — button, badge, card, input, skeleton, popover, tabs, sheet, drawer, chart
10. **index.css** — theme system (swap colors as needed)
11. **Edge functions** — chat (swap system prompt + retrieval), semantic-search (swap table/RPC names)

### What to customize per domain:
1. **Types** — Replace `NsrRecord` with your domain record type (e.g. `SportsRecord`, `LegalCase`)
2. **SQL schema** — New main table with your domain columns + embedding column + structured arrays
3. **Supabase views** — New `distinct_*` views for your domain's filterable fields
4. **RPC functions** — Adapt `search_nsr_structured` for your domain's filter fields
5. **Chat system prompt** — Replace nuclear science context with your domain expertise
6. **PlusMenu categories** — Replace Nuclides/Reactions/Authors with domain-specific categories
7. **NuclideCombobox / ReactionCombobox** — Replace with domain-specific filter comboboxes
8. **NsrRecordCard** — Redesign card layout for your domain's data shape
9. **Features.tsx** — Update comparison data for your domain
10. **Page names & routes** — Rename /references, /endf, etc. to match your domain
11. **Embeddings script** — Run embed script against your new data
12. **Public assets** — Swap logos

### Environment variables needed:
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# Edge function secrets (set via supabase secrets set):
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SEMANTIC_SCHOLAR_API_KEY=optional
```

---

## Full Dependency List (package.json)

### Production
```
@radix-ui/react-dialog ^1.1.15
@radix-ui/react-popover ^1.1.15
@radix-ui/react-tabs ^1.1.13
@supabase/supabase-js ^2.97.0
@tanstack/react-query ^5.90.21
class-variance-authority ^0.7.1
clsx ^2.1.1
csv-parse ^6.1.0
lucide-react ^0.575.0
react ^19.2.0
react-dom ^19.2.0
react-markdown ^10.1.0
react-router-dom ^7.13.0
recharts ^3.7.0
sonner ^2.0.7
tailwind-merge ^3.5.0
tailwindcss-animate ^1.0.7
vaul ^1.1.2
```

### Dev
```
@eslint/js ^9.39.1
@tailwindcss/vite ^4.2.0
@types/node ^24.10.1
@types/react ^19.2.7
@types/react-dom ^19.2.3
@vitejs/plugin-react ^5.1.1
eslint ^9.39.1
eslint-plugin-react-hooks ^7.0.1
eslint-plugin-react-refresh ^0.4.24
globals ^16.5.0
tailwindcss ^4.2.0
typescript ~5.9.3
typescript-eslint ^8.48.0
vite ^7.3.1
```
