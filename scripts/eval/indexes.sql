-- HNSW indexes. Run AFTER a sweep is green, never before: index maintenance
-- during a 400k-row upsert is the whole cost, which is why sql/08 ships the
-- table without one.
--
-- THE OPCLASS MUST MATCH THE ARM'S METRIC. pgvector will happily build a cosine
-- index and then decline to use it for a <#> query — you get a sequential scan
-- and a correct-but-slow answer, which is the worst kind of wrong because
-- nothing fails. bge-m3 and our fine-tune are cosine models (normalized
-- vectors, <=>); MedCPT / SPECTER2 / SciNCL are dot-product models over raw
-- [CLS] (<#>). See the registry in scripts/eval/score.mjs.

-- our arm + the stock baseline: cosine
CREATE INDEX IF NOT EXISTS idx_pp_emb_hnsw
  ON preprint_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_pp_emb_cshl_hnsw
  ON preprint_embeddings_cshl USING hnsw (embedding vector_cosine_ops);

-- the in-domain / scholarly baselines: inner product
CREATE INDEX IF NOT EXISTS idx_pp_emb_medcpt_hnsw
  ON preprint_embeddings_medcpt USING hnsw (embedding vector_ip_ops);
CREATE INDEX IF NOT EXISTS idx_pp_emb_specter2_hnsw
  ON preprint_embeddings_specter2 USING hnsw (embedding vector_ip_ops);
CREATE INDEX IF NOT EXISTS idx_pp_emb_scincl_hnsw
  ON preprint_embeddings_scincl USING hnsw (embedding vector_ip_ops);

ANALYZE preprint_embeddings;
