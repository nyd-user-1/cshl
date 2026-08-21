> **CSHL — cloned from `/Code/nsr` on 2026-08-18.** This repo is a 1-1 duplicate of
> NSRgpt (nsr @ `8c1b05b`) with the BNL mark swapped for the CSH logo. Everything
> below still describes the NSR app and its data, and stays true until the two CSHL
> APIs land and the content is swapped over 1-1. Production: **https://cshl.nysgpt.com**.
>
> **Database.** CSHL's own Neon project `cshl` (`snowy-pine-70124980`, aws-us-east-1,
> Postgres 17, autoscale 0.25–4 CU, `vector` + `pg_trgm` enabled) exists and is empty.
> Local `.env.local` (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`) points at it, so every
> loader run from this repo writes to CSHL and never to NSR. Vercel production
> `DATABASE_URL` still points at the NSR database so the deployed site keeps rendering;
> the same cshl strings are staged there as `CSHL_DATABASE_URL[_UNPOOLED]`. Cutting over
> is a one-variable rename once there is data to serve.

# NSRgpt — RxivGPT

A search, chat, and browsing layer over the Nuclear Science References corpus
and its sibling NNDC databases (ENSDF, XUNDL, ENDF), backed by our own
fine-tuned retrieval stack (**NSR-CPT**). Production: **https://nsr.nysgpt.com**.

## What's in the box

- **Corpus** — Neon Postgres (`sparkling-moon-06542876`): 303,568 rows =
  the complete NSR dump (255,315 entries, exact parity with NNDC's monthly
  archival) + arXiv/APS additions, full relational layer (authors, nuclides,
  reactions, subjects, EXFOR, ENSDF, XUNDL), S2/OpenAlex enrichment.
- **NSR-CPT** — bge-m3 fine-tuned on NSR's 206k expert keyword abstracts +
  EXFOR links, plus a cross-encoder reranker and a frozen benchmark. Four
  private HF repos under `NYSgpt`. Full story: `docs/NSR-CPT-REPORT.md`.
- **App** — React 19 + Vite + TS SPA: `/search` (Hybrid/Semantic/Keyword,
  chart widgets), `/chat` (Bedrock streaming with Neon retrieval),
  `/references`, `/graph` (React Flow canvas), `/community`, `/tools`
  (NNDC calculator ports), and NNDC-parity data-source sections `/ensdf`,
  `/xundl`, `/endf`, plus `/nsr/archive` et al.

## Architecture rules that bite (read before touching anything)

- **Vercel functions use the classic `(req, res)` signature.** Web-standard
  handlers HANG on this project. Functions are unbundled ESM — local imports
  need the `.js` extension (`import … from "./_lib/embed.js"`).
- **DB access:** `@neondatabase/serverless` in `api/*`; bulk loaders use
  `psql \copy` against `DATABASE_URL_UNPOOLED`. Vector queries must pass the
  vector as a bound `$1::vector` parameter (a join-sourced probe defeats HNSW),
  and `SET LOCAL hnsw.ef_search` needs `sql.transaction([...])`.
- **Encoder switch:** `SEARCH_ENCODER=nsr` serves our encoder via the
  `nsr-serve` EC2 box; `=bge` falls back to stock bge-m3 on Cloudflare
  Workers AI (free). Reranker is opt-in (`&rerank=1`).
- **Bedrock auth** is via `AWS_BEARER_TOKEN_BEDROCK` only.
  Everything is **us-east-1**: `nsr-pdfs`, Neon, Bedrock, the KB and its S3
  Vectors index, AgentCore. `BEDROCK_REGION` was us-east-2 — inherited from the NSR
  clone, pointing at a region holding no resource of ours — and was moved to us-east-1
  on 2026-08-20. It also cost us a model: `qwen.qwen3-coder-next` is not offered in
  us-east-2, so that picker entry could not have worked.
- **Device rules:** nothing heavy runs on the laptop — GPU/bulk work goes to
  self-terminating EC2 boxes (rigs under `scripts/embed-nsr/`,
  `scripts/train-nsr/`, etc.). Spending AWS credits requires Brendan's
  express permission.
- Gate every commit with `npx tsc -b && npm run build`; check generated files
  for NUL bytes.

## Running it

```sh
npm install
npm run dev        # vite on :3000; /api/* proxied to production (vite.config.ts)
npm run build      # tsc -b + vite build
```

Serverless functions live in `api/` and only run on Vercel (or `vercel dev`).
Secrets in `.env.local` (never committed): `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `CF_ACCOUNT_ID`/`CF_AI_TOKEN`,
`AWS_BEARER_TOKEN_BEDROCK`, `NSR_*` serve vars.

## Data pipeline (rebuild order)

Every script is run by hand: `node --env-file=.env.local scripts/<x>.mjs`.
Headers in each script are the authoritative docs.

1. **Load** — `scripts/load-nsr-dump.mjs` (full NNDC dump → Neon; sql/13–14)
2. **Ingest** — `ingest-{arxiv,aps-feeds,scoap3,exfor,ensdf,ensdf-archive,xundl-archive}.mjs`
3. **Enrich** — `enrich-s2-batch.mjs`, `enrich-openalex-batch.mjs`
4. **Static JSON** — `build-structure-data.mjs`, `build-catalog.mjs`,
   `build-{nsr,xundl}-archivals.mjs`, `build-{ame2020,be2,bbdecay,capgam}.mjs`
   → `public/data/` (the frontend's CDN layer; version query strings when the
   shape changes — the edge caches for a day)
5. `vite build`

## Where the truth lives

- `docs/NSR-CPT-REPORT.md` — the model program, results, live-serving state
- `docs/data-accounting.md` — corpus ground truth and dump anatomy
- `docs/HANDOFF-2026-08-16.md` — running handoff with dated addenda
- `docs/prompts/LANE-*.md` — every executed lane brief with its REPORT
- `sql/` — numbered migrations (04 and 11 intentionally absent)

Legacy warning: `supabase/` and several `scripts/*.{sh,py}` are dead
Supabase-era code kept for history — nothing in production reads Supabase.
