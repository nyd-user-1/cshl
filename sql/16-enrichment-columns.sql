-- Enrichment columns for the three-lane sweep (S2 / OpenAlex / arXiv).
-- Written by the lead; lanes write ONLY their owned columns (see docs/prompts/).
-- Shared columns (arxiv_id, pdf_url) are always written with
-- COALESCE(existing, new) so first-writer-wins and lanes cannot clobber.

BEGIN;

ALTER TABLE nsr
  ADD COLUMN IF NOT EXISTS arxiv_id text,          -- shared: S2 + OpenAlex + arXiv, coalesce
  ADD COLUMN IF NOT EXISTS openalex_id text,       -- LANE-OPENALEX
  ADD COLUMN IF NOT EXISTS oa_status text,         -- LANE-OPENALEX (gold/green/bronze/closed)
  ADD COLUMN IF NOT EXISTS oa_locations jsonb,     -- LANE-OPENALEX (all OA locations)
  ADD COLUMN IF NOT EXISTS openalex_topics jsonb,  -- LANE-OPENALEX
  ADD COLUMN IF NOT EXISTS openalex_cited_by int,  -- LANE-OPENALEX
  ADD COLUMN IF NOT EXISTS pdf_url text,           -- shared: best resolvable OA pdf URL, coalesce
  ADD COLUMN IF NOT EXISTS pdf_stored text;        -- LANE-ARXIV: where WE hold the file (s3 key / path)

CREATE INDEX IF NOT EXISTS idx_nsr_arxiv_id ON nsr (arxiv_id) WHERE arxiv_id IS NOT NULL;

COMMIT;
