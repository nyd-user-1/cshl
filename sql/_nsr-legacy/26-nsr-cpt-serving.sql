-- 26 — Stage 5 cutover (2026-08-17): the candidate table written by LANE-TRAIN's
-- Phase 3 (corpus re-embedded with NYSgpt/nsr-encoder-bge-m3, run
-- 20260817-021635-train, HNSW m=16/ef_construction=64) becomes the serving
-- table for SEARCH_ENCODER=nsr. Applied via node (unpooled) at 03:2x; kept
-- here as the record. Stock bge-m3 vectors stay in nsr_embeddings (kill-switch).
ALTER TABLE nsr_embeddings_candidate RENAME TO nsr_embeddings_nsr;
ALTER INDEX nsr_embeddings_candidate_embedding_idx RENAME TO nsr_embeddings_nsr_embedding_idx;
ALTER INDEX nsr_embeddings_candidate_pkey RENAME TO nsr_embeddings_nsr_pkey;
COMMENT ON TABLE nsr_embeddings_nsr IS 'NSR-CPT: corpus vectors from NYSgpt/nsr-encoder-bge-m3 run 20260817-021635-train (Stage 5). Serving table when SEARCH_ENCODER=nsr.';

-- 2026-08-18: nuclide pages look up papers by (A, element) — nsr_nuclides only had (key) and (z,a).
CREATE INDEX IF NOT EXISTS idx_nsr_nuclides_a_el ON nsr_nuclides (a, upper(element_symbol));
