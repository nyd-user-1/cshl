-- 21: on-demand full-text cache for /api/chat (LANE-MEDRXIV-ROOMS Task 1b).
--
-- The generator has only ever seen the ~1,670-char abstract; every fact the
-- failed test answers missed lives in the body. /api/chat now fetches full
-- text for the top records that reach the prompt (JATS preferred, article
-- HTML fallback, Europe PMC third) and caches the section-trimmed result
-- here so the second ask is free.
--
-- This table is deliberately NOT preprints, NOT preprint_embeddings*, and
-- not read by any benchmark. `source` records which rung of the fetch
-- ladder answered; `text` is already trimmed to what a reader needs
-- (abstract + results + discussion by default), not the raw 60k-char body.

CREATE TABLE IF NOT EXISTS preprint_fulltext (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  source      text NOT NULL,          -- 'jats' | 'html' | 'epmc'
  text        text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
