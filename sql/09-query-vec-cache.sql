-- 09: memoized query embeddings for /chat and /search.
--
-- Keyed by md5(encoder:text) so a repeated question costs one indexed lookup instead
-- of an encoder round trip. api/_lib/embed.ts degrades silently if this table is
-- absent, so it is an optimization and never a dependency — but /chat is a surface
-- Brendan will type into, and a second saved per repeated question is worth a table.
BEGIN;
CREATE TABLE IF NOT EXISTS query_vec_cache (
  text_hash  text         NOT NULL,
  model      text         NOT NULL,   -- the EMBEDDING SPACE, i.e. the corpus table name:
                                      -- 'preprint_embeddings' (stock bge-m3) |
                                      -- 'preprint_embeddings_cshl_qp' (fine-tuned, currently served).
                                      -- NOT the encoder name: SEARCH_ENCODER=nsr is a slot whose
                                      -- weights change, and a cache keyed on the slot outlives the
                                      -- model in it. See cacheKeyModel() in api/_lib/embed.ts.
  embedding  vector(1024) NOT NULL,
  hits       int          NOT NULL DEFAULT 1,
  created_at timestamptz  NOT NULL DEFAULT now(),
  last_seen  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (text_hash, model)
);
COMMIT;
