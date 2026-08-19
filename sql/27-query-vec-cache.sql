-- 27 — query-vector memo for /api/search and /api/chat (Stage 5 latency):
-- repeated questions skip the encoder call. Keyed by md5('<model>:<text>').
CREATE TABLE IF NOT EXISTS query_vec_cache (
  text_hash  text        NOT NULL,
  model      text        NOT NULL,           -- 'bge' | 'nsr'
  embedding  vector(1024) NOT NULL,
  hits       int         NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_hash, model)
);
