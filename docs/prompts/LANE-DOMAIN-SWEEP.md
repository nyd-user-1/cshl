# LANE-DOMAIN-SWEEP — finish the NSR→CSHL content conversion of the live UI

Append-only, timestamped (UTC). Fence: `src/` only — no `api/` changes, no schema, no
training, no deploys past preview. **Not** this lane's: `src/pages/GraphPage.tsx`,
`src/components/ChatDock.tsx`, `src/components/EntityDetail.tsx`, `src/components/FlowSettings.tsx`
(all belong to LANE-GRAPH-CSHL). Laptop rule: `npx tsc -b` and `vite build` are fine; nothing heavier.

## Context you must read first

- The mechanical half is DONE on `main` (commit `06f9d20`+): dead nuclear pages deleted, the
  card-page design preserved content-agnostic in `src/pages/templates/CardPage.tsx`, renames
  (`NsrRecordCard`→`RecordCard`, `NsrRecord`→`CorpusRecord`, `useNsr*` hooks, `types/nsr`→
  `types/record`, badge variant + color token `nuclear`→`brand`), `/references` now canonical
  with `/nsr` redirecting, placeholders/labels/sample prompts swapped to preprint content.
- **The standing rule (Brendan, 2026-08-21):** this repo gets re-skinned per information
  domain — NSR → CSHL preprints → next (tariffs or chemistry). Whatever CAN be
  info-domain-agnostic SHOULD be: identifiers, component names, tokens, keys are structure
  (agnostic); user-visible copy is content (domain-specific, but concentrated so the next
  flip touches few files). When you must choose, prefer a data-driven component with the
  domain content in one obvious literal at the top of the file.
- The persisted wire key `sources.nsr` in `src/types/chat.ts` is KEPT deliberately —
  renaming orphans stored chat sessions' source chips. Do not rename it.

## Tasks, in order

1. **`src/pages/Features.tsx` (403 lines) — full content rewrite.** It is still the
   "NNDC NSR vs RxivGPT" comparison. Rewrite as **bioRxiv/medRxiv native search vs RxivGPT**,
   same table design. Every claim on our side must be TRUE of the deployed product — verify
   each against the code before writing it (search modes in `api/search.ts`, embeddings/
   encoder roster in `src/lib/models.ts` and `/models`, similar-preprints via cshl-CITE,
   chat grounding). House rule: no "only X on Earth" superlatives — "first that we know of"
   is the ceiling. Footer URL: the production domain, not nsr.nysgpt.com — READ the current
   Vercel prod alias to get it right; do not guess.
2. **`src/pages/Resources.tsx` — replace the nuclear link directory** (TALYS, NSR Online,
   EXFOR…) with the biomedical-preprint equivalents: bioRxiv/medRxiv APIs, PubMed/Europe PMC,
   Semantic Scholar, OpenAlex, CSHL press pages — each with an honest one-line description.
   Keep the page's design unchanged.
3. **`src/pages/Search.tsx` facets — remove the inert nuclear facet machinery.**
   `TOPIC_LABEL` still enumerates NSR keyword topics ("Nuclear reactions"…) and
   `withAllValues` forces them to render at count 0 on the live page; the `ELEMENTS`
   nuclide-parsing helper (from `lib/structure`) has no preprint meaning. Replace the topics
   facet with what the corpus actually has (`categories`, `server`, published-status,
   `reference_type` already works). If nothing else still imports `lib/structure` after
   this, delete `lib/structure` and clean `types/record.ts`'s NSR-era facet fields
   (`topics`, `exfor_keys`… — grep before deleting each).
4. **Sweep gate.** `grep -rniE "\bnsr\b|\bbnl\b|nndc|nuclear" src --include="*.tsx"
   --include="*.ts" --include="*.css"` and account for EVERY hit in the log: allowed
   survivors are (a) the persisted `nsr` wire key + its comment, (b) comments that
   explain NSR-era history, (c) the LANE-GRAPH-CSHL fence files. Anything else gets fixed
   or explicitly justified in the log.

## Verification, every task

`npx tsc -b` clean AND `npm run build` clean before a task is called done (note: tsc does
not check `api/` — irrelevant here since `api/` is fenced off). After task 4, `vercel deploy`
(preview, NOT prod) and click through /features, /resources, /search, /references once;
record the preview URL in the log. Brendan flips to prod himself.

## Status reporting

Append a dated log entry at: lane start (state read, before touching anything), after each
numbered task, and at the end with the final grep-gate accounting. Claims of "done" carry
the verifying command + its output, not a summary.

---

## Log

(append here)
