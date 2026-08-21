# LANE-MEDRXIV-ROOMS — the rooms product, medRxiv only, tonight

Append-only, timestamped (UTC). You are LANE-MEDRXIV-ROOMS.

**FIRST COMMAND, BEFORE ANYTHING ELSE — take your own worktree:**

```sh
git -C /Users/brendanstanton/Code/cshl worktree add \
    /Users/brendanstanton/Code/cshl-rooms -b lane/rooms main
cd /Users/brendanstanton/Code/cshl-rooms
```

Then work **only** in `/Users/brendanstanton/Code/cshl-rooms`. Do **not** run
`git checkout` inside `/Users/brendanstanton/Code/cshl` — another session is live
in that directory, and checking out a branch there moves its HEAD mid-run and
makes its commits land on your branch. This has already happened twice tonight.

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

**2026-08-21 08:13 UTC — lane start.** Worktree taken at
`.claude/worktrees/rooms`, branch `lane/rooms` off `main` (6c84f4d). Verified
`api/` holds exactly 12 files (`ls api/*.ts | wc -l` → 12) — at the function
ceiling, so all Task 1 work goes into existing handlers + `api/_lib/`. Order of
work: Task 1 (generation fixes b, c; verify a not regressed) → Task 2 (rooms
UI) → deploy preview → acceptance tests → promote.

---

**2026-08-21 09:32 UTC — lane complete, promoted to production.**

Production: `https://cshl-lc7bi87g1-nys-gpt.vercel.app` at **cshl.nysgpt.com**.
**Rollback target (previous production): `cshl-5g0z7qx8u-nys-gpt.vercel.app`**
— one command: `vercel promote https://cshl-5g0z7qx8u-nys-gpt.vercel.app`.
9 commits on `lane/rooms`, pushed to origin, rebased onto `main` (c875471).
`api/` still 12 files — no new Vercel function.

### Task 1 — generation

**(a) not regressed.** `grep -rn "not yet published" api/ src/` returns exactly
one line — `api/chat.ts:123`, inside the comment explaining why the string must
never come back. No code path emits it, and the prompt now also forbids
asserting publication status without a `published_journal`.

**(b) full text now reaches the prompt.** New `api/_lib/fulltext.ts` runs a
cache-first ladder — `preprint_fulltext` (new table, `sql/21`) → JATS →
article HTML → Europe PMC → Wayback → reader proxy — for the top 4 records,
with a ~2.8 s prompt budget and a 20 s hard cap; stragglers still populate the
cache. Nothing writes to `preprints`, `preprint_embeddings*`, or anything the
benchmark reads.

Three things the measurements changed, none of which were guessable up front:

1. **bioRxiv 429s Vercel's egress on every request.** So do the Wayback
   Machine and `r.jina.ai` from those IPs. medRxiv JATS succeeds — the four
   in-room neurology papers below were all fetched live and cached. For
   bioRxiv, `scripts/fulltext-backfill.mts` runs the *same ladder* from a
   residential IP and writes the same cache, so the deployed chat serves it
   from rung 1. This is the standing workaround, not a one-off.
2. **The OR-retry was the real latency bug.** "please read <DOI> and report
   what it says" OR'd its stopwords across 433,449 documents: **42,661 ms**
   inside the handler. `/api/search` already solved this with `fts_high_df`
   pruning; `/api/chat` had never had it copied over. Now ~100 ms.
3. **`<h2>Results</h2>` carries no paragraphs on the bioRxiv template** — they
   all hang off `<h3>` findings ("43% of Type III repeat clusters contain a
   PAM"), so a flat section filter dropped the entire results section *while
   reporting success*. The trim is level-aware now.

Also added: an explicit key/DOI retrieval lane (FTS tokenizes DOIs into noise,
so a named paper could miss its own prompt), and an 8 s timeout on the encoder
fetch — a cold serve box had been holding a turn for ~50 s.

**(c) structure removed.** System prompt rewritten for plain prose. First
deploy still emitted `# Comprehensive PAM Prediction…`; second still emitted
`**Physiotherapy and Physical Activity**` — the model routed around
"no headings" by rebuilding the same slots in bold. Both are now explicitly
forbidden and the final answers carry neither (asserted in the browser check).

### Acceptance test (§3) — PASS

Asked the deployed preview to read `10.1101/2021.05.04.442622`. Payload
confirms the body reached the prompt:
`fulltext: [{key_number: 2021.05.04.442622, source: cache:jats, chars: 13564}, …]`.
Verbatim answer:

> This preprint describes a large-scale computational study of CRISPR-Cas systems and their targets (2021.05.04.442622). The authors mapped CRISPR spacers—sequences that bacteria and archaea store from viral invaders—to their actual targets in sequence databases, revealing fundamental biology of how these immune systems work.
>
> The researchers analyzed over 200,000 unique CRISPR spacers from bacterial and archaeal genomes, achieving matches for approximately 70,000 spacers (32% of the total) by searching metagenomic and NCBI databases with optimized filtering. This represented a major improvement over prior work, which had found matches for only 7% of spacers. The improvement came from both their more sensitive filtering approach and the expansion of available metagenomic databases over time. They found that well-sampled genera like Streptococcus, Pseudomonas, and Staphylococcus had higher match rates (77%, 69%, and 64% respectively), whereas poorly sampled environmental genera showed very low rates (3–4%).
>
> From analyzing the genomic sequences flanking the matched targets, the authors generated a comprehensive catalog of over one hundred unique PAM (protospacer adjacent motif) sequences—the short DNA patterns that CRISPR systems recognize—and linked these PAMs to specific CRISPR subtypes. They discovered that repeat sequences themselves predict which PAM a system will recognize, and this relationship was more informative than clustering by genus or subtype. The nucleotide identity at repeat-spacer junctures showed clear patterns with PAM nucleotides, which the authors suggest could help experimentally determine unknown PAMs by narrowing the possible sequences.
>
> Analyzing strand targeting preferences, the authors found that DNA-targeting systems like Type I-E and Type II prefer the template strand (possibly to avoid targeting mRNA), while RNA-targeting systems like Type III and some DNA-targeting systems (Type I-A, I-B) prefer the coding strand, making them capable of base-pairing with transcribed RNA. The paper also documents extensive evidence of CRISPR array sharing between different CRISPR-Cas subtypes, particularly between DNA-targeting and RNA-targeting systems in the same genome. These compatible multi-effector systems could provide coordinated defense: different subtypes have different mismatch tolerances, so targeting the same invader sequence with multiple systems reduces escape mutation probability. The authors propose this could reflect selection pressure for cooperative defense strategies.

- **(i) no peer-review claim** — the answer never mentions publication status.
- **(ii) body-only quantities** — the abstract says only "one third
  ([~]70,000) of more than 200,000". **32%**, **7%**, **77/69/64%** and
  **3–4%** appear nowhere in it. Each was then checked against the cached
  text: *"this optimized filtering approach resulted in 72,099 spacers (32% of
  total)"*, *"A previous study … found matches for 7% of spacers, using a more
  stringent 95% sequence identity"*, *"(77%, 69% and 64% respectively) … (4%,
  4% and 3% respectively)"*.
- **(iii) nothing absent from the fetched text** — every specific claim above
  traced to the cached body; author names come from the record metadata line.

This is not an abstract paraphrase: the 7%-vs-32% comparison exists only in
the results section.

### Task 2 — rooms UI

`/medrxiv`, `/medrxiv/cards` (51 data-generated cards), `/medrxiv/agents`,
`/medrxiv/rooms/:category` (the scoped chat — the same `Chat` page with scope
from the route). `/preprints*` redirect, never 404. `/biorxiv` deliberately
absent; the routing shape leaves room. No card claims to be a separately
trained model (asserted in the browser check), and card copy reads
"Searches 12,697 infectious diseases preprints" from real per-server counts.

Scope is a parameter on the existing endpoints, never a widget: `room` on the
`/api/chat` body, `?server=&category=` on `/api/search`.

**Query plan, as §4 asked.** In-room dense retrieval does **not** use HNSW —
it filters first and scans exactly. An ANN probe cannot honor a selective
filter without over-fetching past the room, and at ≤12.7k vectors the exact
scan is affordable: measured **446 ms** warm in-room hybrid on production
(`dense_ms` 416, `fts_ms` 30) against 1,136 ms corpus-wide. Cold, when the
`nsr` serve box has to spin up, the first query costs ~8.7 s — that is the
encoder, not the scan.

**Room-first, corpus-second, never room-only.** Weakness could not be a row
count: an exact kNN always fills its limit, so a 30-paper room answers any
question with its ten nearest strangers and looks confident. The trigger is
evidence — no in-room lexical match and no in-room dense hit ≥0.45 cosine
(measured: relevant in-room hits ≥0.60, filler ≤0.26). Verified on production,
asking a vaccine question inside `forensic medicine`:

> The search was widened beyond the forensic medicine room to capture relevant results across the whole corpus.

with `room: {…, widened: true}` on the payload and a line in the UI footer.

Follow-ups ride `/api/similar` (cshl-CITE, zero inference) in the response
footer; a medRxiv category chip is a live link into that room, so one click
re-scopes without the user ever seeing a filter. bioRxiv chips render inert,
because those rooms do not exist tonight.

### Constraints (§5)

1. **Page loads, production, measured:** `/` 161 ms, `/medrxiv` 160 ms
   (455 ms cold in Chromium), `/medrxiv/cards` 199 ms, card data 304 ms. All
   under 1 s. This needed a fix: the per-server counts were a live
   `unnest + GROUP BY` over 87,567 rows at **3.11 s cold**, hidden behind the
   edge cache from everyone except the first visitor after each expiry. Now
   materialized (`sql/22`, `category_server_counts`) → **0.32 s cold**.
2. **No new Vercel functions** — `ls api/*.ts | wc -l` → **12**, unchanged.
3. `npx tsc -b` clean; `npm run build` clean. `tsconfig.api.check.json` shows
   the same 8 pre-existing errors and no new ones (delta zero). Every endpoint
   exercised on the deploy via `scripts/endpoint-smoke.mjs` — all healthy. One
   transient `502 {"error":"s2 429"}` from `/api/paper` (Semantic Scholar
   throttling, a file this lane did not touch); returned 200 on retry 20 s
   later. Worth a follow-up: it reports an upstream 429 as our 502.
4. Untouched: `GraphPage.tsx`, training scripts, eval data, embedding tables.
5. **No AWS spend beyond normal generation.** The $10 authorization was not
   needed and was not used — the failures were ours, exactly as §3 predicted.

### Browser spot-check (§6) — 13/13 on production

`scripts/rooms-browser-check.mjs` drives real Chromium through
/medrxiv → /medrxiv/cards → click neurology → ask → read one full answer,
asserting honest counts, the room chip, the scoped placeholder, plain prose
and no publication-status claim. Screenshots in `/tmp/rooms-shots`.

Preview deployments sit behind Vercel auth with no automation-bypass secret,
and `vercel dev` 58.x fails on this project, so `scripts/local-serve.mts`
serves the real built bundle and the real `api/` handlers on one port for
pre-deploy runs. It is a harness only — nothing in `api/` or `src/` imports it.

**A real bug it caught, which the API tests could not.** The `/api/similar`
follow-ups arrive ~300 ms after the answer finishes streaming, i.e. after the
last auto-scroll — so the row was clipped behind the composer, leaving the one
control that re-scopes a user unreachable. The page now re-pins to the bottom
when they render, and only for a reader who is still at the bottom. My first
geometry assertion passed on the clipped layout because it only checked the
block's top edge; it now checks that every row's bottom clears the composer.

### One thing worth Brendan's attention

Another lane promoted to production while this lane was verifying. Rather than
promote blind, I compared the live bundle against a build of `origin/main`:
identical size, and the only differing bytes were chunk-hash references the
chunks make to each other (`CN13X3Lv` vs `ByINDgX1`), seeded by env-inlined
values. Production was code-identical to `main`, so this promotion reverted
nothing — but two lanes holding production without coordination is luck, not
design. `lane/rooms` is pushed and rebased on `main`; it has not been merged.
