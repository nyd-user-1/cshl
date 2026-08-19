-- 08: bge-m3 vectors for the preprint corpus.
--
-- Sidecar keyed by the business key, mirroring LANE-RXIV-MAP §6 and NSR's sql/23.
-- Proposed by the rig-port lane (LANE-RIG-PORT.md §5-DDL) and applied here because
-- sql/ belongs to this lane. Written by scripts/embed-nsr/worker.mjs.
--
-- TABLE ONLY. No vectors are written tonight — the scope guard stands: no embed run,
-- no encoder, no reranker, no classifier. This is the empty shape the rig needs to
-- exist before it can be launch-ready, and it was already part of the Task-6 schema
-- proposal Brendan approved in (a).
--
-- Amendment to the proposal as filed: ON DELETE CASCADE. The rig's note (a) asks that
-- the FK be kept, and it is — cascade only decides what happens when a preprint row
-- goes away. Without it, ever deleting a paper (a withdrawn row dropped in a future
-- reload) fails on a dangling embedding; with it, the stale vector goes too, which is
-- the only correct outcome — an embedding for a paper that no longer exists is
-- garbage that would still answer kNN queries.
--
-- `model` is deliberately not decorative: the fine-tuned encoder writes its own value
-- here, and an arm that silently claims to be stock bge-m3 is how an eval table lies.

BEGIN;

CREATE TABLE IF NOT EXISTS preprint_embeddings (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  embedding   vector(1024) NOT NULL,          -- bge-m3
  model       text NOT NULL DEFAULT 'bge-m3', -- set explicitly on every upsert
  text_hash   text NOT NULL,                  -- md5 of the EXACT string sent to the encoder
  embedded_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

-- HNSW comes AFTER the full embed pass, never before — index maintenance across a
-- 433k-row upsert sweep is the whole cost. Run as its own statement once green:
--   CREATE INDEX IF NOT EXISTS idx_pp_emb_hnsw
--     ON preprint_embeddings USING hnsw (embedding vector_cosine_ops);
