-- Full-text retrieval for /api/chat and /api/references: one indexed tsvector
-- over title + keywords + abstract. Replaces the dead OpenAI-embedding lane
-- until the bge-m3 re-embed; covers the FULL 303k corpus (the old semantic
-- lane only ever saw 46k rows).
BEGIN;
ALTER TABLE nsr ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(keywords, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(abstract, ''), 4000)), 'C')
  ) STORED;
COMMIT;
CREATE INDEX IF NOT EXISTS idx_nsr_fts ON nsr USING gin (fts);
ANALYZE nsr;
