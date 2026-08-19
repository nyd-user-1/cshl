-- LANE-TRAIN Phase 3: candidate embeddings from the trained nsr-encoder-bge-m3
-- checkpoint, scored against LANE-EVAL's frozen benchmark as arm "D".
-- Same shape as sql/23-embeddings.sql / LANE-EVAL's sql/24-eval.sql, keyed by
-- run_id so a re-run overwrites cleanly (one active candidate run at a time,
-- per LANE-TRAIN.md Phase 3's literal schema: "key_number PK").
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nsr_embeddings_candidate (
  key_number  text PRIMARY KEY REFERENCES nsr(key_number),
  run_id      text NOT NULL,
  embedding   vector(1024) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);
-- HNSW index comes AFTER the full load (train.sh builds it at the end of the
-- candidate-embed step), same law as sql/23-embeddings.sql.

-- Frozen eval queries, re-embedded in the candidate's space (LANE-EVAL's
-- nsr_eval_queries table is the source of `text`; schema per LANE-EVAL.md
-- Phase 2 — re-verify qid/text column names are unchanged before this runs).
CREATE TABLE IF NOT EXISTS nsr_eval_queries_candidate (
  qid         text PRIMARY KEY,
  run_id      text NOT NULL,
  embedding   vector(1024) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);
