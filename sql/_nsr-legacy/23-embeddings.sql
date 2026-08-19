-- 23: nsr_embeddings — dense vectors for the full corpus (bge-m3, 1024-dim).
-- Sidecar table keyed by key_number; the legacy nsr.embedding vector(256)
-- column (Supabase-era, title+keywords, text-embedding-3-small) is untouched.
--
-- Input recipe (deterministic, no exceptions):
--   trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,''))
-- capped at 2000 chars before embedding (the proven embed-v2 cap; TEI
-- truncate:true is the backstop). text_hash = md5 of the exact string sent
-- to TEI (JS-trimmed, capped) so later re-embeds — e.g. after TeX
-- normalization — are detectable by hash mismatch.
--
-- Exclusion (house rule, in SQL not JS-skip): rows with under 20 chars of
-- usable text — length(regexp_replace(title||abstract, '\s+', '', 'g')) < 20
-- — are never claimed.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nsr_embeddings (
  key_number  text PRIMARY KEY REFERENCES nsr(key_number),
  embedding   vector(1024) NOT NULL,          -- bge-m3
  model       text NOT NULL DEFAULT 'bge-m3',
  text_hash   text NOT NULL,                  -- md5 of the embedded input
  embedded_at timestamptz NOT NULL DEFAULT now()
);

-- HNSW index comes AFTER the full load (Phase 4 of the lane). Not before.
