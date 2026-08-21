# LANE-MEDRXIV-ROOMS — the rooms product, medRxiv only, tonight

Append-only, timestamped (UTC). You are LANE-MEDRXIV-ROOMS in
`/Users/brendanstanton/Code/cshl`, branch `lane/rooms`, branched from `main`.
Everything you need is measured below — do not re-derive it, and do not read the
old session transcripts (they are large and off-task).

**Scope discipline:** tonight is **medRxiv only** — clinical/health preprints.
Do not build the bioRxiv surfaces, do not write biology exposition, keep all
prose infrastructural. This is a deliberate scope cut, not a data problem.

**House rules:** 8 GB laptop, nothing heavy runs locally (no torch, no bulk
processing). No Hugging Face pushes. Verify artifacts, never accept a success
report. Append a dated log entry at lane start, after each task, and at the end;
claims of "done" carry the verifying command and its output.

---

## 1. What you are building, in one paragraph

The product's thesis (full doctrine: `/Users/brendanstanton/Code/forge/docs/SMALL-WORLDS.md`)
is that our fine-tuned retrieval stack is good over the whole corpus and
*absurdly* good over small, coherent subsets of it — so the product is designed
so that **every query is already scoped before it is typed**. Scope is set by
navigation, not by a filter widget and not by a model guessing: the user picks a
card, and that click is the routing decision. **There are no bare inputs
anywhere in the product** — an unscoped catch-all chat box does not exist.

Pipeline per turn: room chosen by navigation → our encoder retrieves inside the
room → our reranker orders the top 50 (not wired yet; out of scope tonight) →
a rented generator answers → our doc-similarity model suggests the next room.

## 2. The measured facts (do not re-query to confirm; they are current)

- `preprints`: 433,449 rows. `server` splits **345,882 biorxiv / 87,567 medrxiv**.
- **medRxiv has 51 categories, 49 of them already under 10,000.** Only
  `infectious diseases` (12,697) and `epidemiology` (11,813) exceed it. Both ship
  **as-is tonight** — a 12.7k room is a 7× shrink from medRxiv and a 34× shrink
  from the corpus. There is no cliff at 10,000; do not split them.
- Categories live in two places: `preprints.categories` (text[]) and the
  `preprint_categories(key_number, category)` join table, plus a `categories`
  table with `category, servers, paper_count`. Use whichever indexes better;
  verify the plan.
- `abstract` averages 1,670 chars. **There is no full text in the database** —
  no body column, no fulltext table.
- `jatsxml_url` and `pdf_url` are populated for **433,449 of 433,449** rows.
- `published_journal` is null for 50.3% of rows, *including papers that are in
  fact published*. Treat null as UNKNOWN, never as "unpublished".

## 3. Task 1 — the generation fixes (do this first; it is the highest-value work)

Five separate generator/pipeline combinations have produced unacceptable answers
on the same test paper. The cause is **ours, not the models'**. Three bugs:

**(a) DONE already on main (`api/chat.ts`) — do not redo, just don't regress it.**
The prompt used to append `| not yet published` whenever `published_journal` was
null. The generator then asserted that falsehood in our voice. The string is
gone. Verify it is still gone.

**(b) The generator has never seen a paper body — only a ~1,670-char abstract.**
Every fact the test answers missed lives in the body. Fix: for the records that
reach the prompt, **fetch the full text on demand**. Claude's own chat client
does this instantly by fetching the bioRxiv/medRxiv **v2 HTML full-text page**;
ours must do the same. Implementation notes:
  - Sources available per row: the article HTML page (derive from `doi`/
    `key_number`), `jatsxml_url` (structured full text — cleanest to parse), and
    `pdf_url`. Prefer JATS, fall back to HTML, then to abstract-only.
  - Fetch only the **top 3–5** records, in parallel, with a hard per-fetch
    timeout (~3s) so a slow origin can never hang a turn.
  - **Cache into a new table** (e.g. `preprint_fulltext(key_number, source,
    text, fetched_at)`) so the second ask is free. Never write to `preprints`,
    to any `preprint_embeddings*` table, or to anything the benchmark reads.
  - Section-trim to what a reader needs (abstract + results + discussion is a
    reasonable default) and cap total prompt context; do not dump 60k chars.
  - Extend, don't multiply: this belongs inside the existing `api/chat.ts`
    (a helper module under `api/_lib/` is fine). **Do not add a new Vercel
    function** — see the constraint in §5.
  - When full text was used, say so in the response payload so the UI can show it.

**(c) Structure creates slots, and slots get filled.** Across the five failed
answers, the two that used headers and a "Significance"-style section were the
two that fabricated; the three that wrote plain paragraphs did not. Fix the
system prompt: plain prose, no invented section scaffolding, never state
publication status unless a record shows it, never describe a finding not present
in the supplied text, and prefer "the retrieved text does not say" over a
plausible completion.

**Acceptance test for Task 1 (must be in your log):** ask the deployed preview
to read `10.1101/2021.05.04.442622` and report what it says. The answer must
(i) not assert peer-review status, (ii) contain at least one specific quantity
that exists only in the body and not in the abstract, and (iii) contain no claim
absent from the fetched text. Paste the answer into the log verbatim. If it
still reads like an abstract paraphrase, the fetch is not reaching the prompt —
say so plainly rather than declaring success.

## 4. Task 2 — the rooms UI (medRxiv only)

- **Retire `/preprints`.** The bucket for tonight is **`/medrxiv`**, with
  `/medrxiv/cards` and `/medrxiv/agents` beneath it. (`/biorxiv` is deliberately
  not built tonight; leave room for it in the routing shape.) Old routes redirect
  rather than 404.
- **The card catalog is the front door.** One card per medRxiv category (51),
  each showing its real paper count and honest copy — e.g. "Searches 5,879
  neurology preprints". **Never claim a card is a separately trained model**;
  it is one encoder plus a scope. Cards are generated from data, not hand-written.
- **Card → scoped chat.** Selecting a card lands the user in a chat that is
  already confined to that room: the room appears as a visible chip
  ("NEUROLOGY"), the placeholder names it ("Ask a neurology question…"), and the
  scope rides every request. Selecting a card must never land on an unscoped chat.
- **Scope is a parameter on the existing endpoints.** `api/search.ts` and
  `api/chat.ts` take a room (server + category) and filter retrieval to it.
  Confirm the query plan: an `= ANY(...)`-style filter can defeat the HNSW index
  and fall back to a sequential scan. If it does, report the latency and say so —
  a correct-but-slow answer changes the engineering, not the recall.
- **Room-first, corpus-second, never room-only.** If in-room results are weak,
  widen the search and tell the user you did. A filter that hides the answer and
  produces a confident empty-handed response is the worst failure we have.
- **Follow-ups from `api/similar.ts`** (our doc-similarity model, already live,
  zero inference): the response footer suggests the next papers/rooms, so
  clicking one re-scopes the user without them ever seeing a filter.

## 5. Constraints (all hard)

1. **Every page loads in under 1 second.** Measure it and put the numbers in the
   log. Prefetch on hover, cache category counts, lazy-load heavy routes.
2. **No new Vercel functions.** `api/` is at the plan's function ceiling — a
   thirteenth file breaks the production deploy. Everything goes into existing
   handlers or `api/_lib/` helpers. Count the files before you deploy.
3. `npx tsc -b` and `npm run build` clean before anything is called done. Note
   that **tsc does not typecheck `api/`** — only a deploy catches those errors,
   so deploy a preview and exercise every endpoint with `vercel curl`.
4. Do not touch: `src/pages/GraphPage.tsx` and its components (another lane),
   training scripts, eval data, embedding tables.
5. Spend: no AWS spend is required for any of this. There is a $10 authorization
   for generation quality if it is *measurably* needed; it should not be.

## 6. Deploy

Preview first (`vercel deploy`), exercise the endpoints, then **spot-check in a
real browser** — `/medrxiv`, `/medrxiv/cards`, a card → chat, and one full
answer — and only then promote to production (`vercel deploy --prod`) at
**cshl.nysgpt.com**, which already exists and points at this project. Record the
previous production deployment id in the log first so a rollback is one command.
Brendan is asleep; he has authorized promotion once everything above is done and
verified. If any acceptance test fails, deploy the preview, leave production
alone, and write `## BLOCKED` with exactly what failed.

## 7. Elsewhere (do not duplicate, do not wait for)

- `lane/librarian` is training the label models and building a room map for the
  full corpus. **You do not need it.** medRxiv's 51 source-assigned categories
  are the rooms tonight.
- `lane/bedrock-kb` holds an unmerged managed-RAG toggle and its harness.
- Curve measurement (optimal room size) is staged but unrun; 10k is provisional
  and, per Brendan, not a threshold to design around.

---

## Log

(append here)
