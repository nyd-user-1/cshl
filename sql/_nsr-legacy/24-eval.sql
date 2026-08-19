-- 24: nsr_eval_queries — the frozen LANE-EVAL benchmark's query embeddings.
-- One row per KW/EX query (docs/prompts/LANE-EVAL.md Phase 1 freeze). The
-- embedding column is filled in Phase 2 by the same bge-m3/TEI rig that
-- embedded the corpus (scripts/eval/embed-queries-worker.mjs).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nsr_eval_queries (
  qid         text PRIMARY KEY,
  family      text NOT NULL,             -- 'KW' | 'EX'
  text        text NOT NULL,
  embedding   vector(1024),               -- bge-m3, filled in Phase 2
  embedded_at timestamptz
);

-- Arm C (Phase 3): Cohere embed-v4 via Bedrock (us-east-1, in-region
-- supported there; 1536-dim, no output_dimension override available on this
-- model per the live invoke response). Corpus side + query side.
ALTER TABLE nsr_eval_queries ADD COLUMN IF NOT EXISTS embedding_commercial vector(1536);
ALTER TABLE nsr_eval_queries ADD COLUMN IF NOT EXISTS embedded_commercial_at timestamptz;

CREATE TABLE IF NOT EXISTS nsr_embeddings_commercial (
  key_number  text PRIMARY KEY REFERENCES nsr(key_number),
  model       text NOT NULL DEFAULT 'cohere.embed-v4:0',
  embedding   vector(1536),
  embedded_at timestamptz
);
