-- Eval-arm vector sidecars. HARNESS-OWNED (approved as scoped by the lead) —
-- these are not app schema and deliberately do not live in sql/, which belongs
-- to the build lane. One table per arm, because the arms disagree about
-- dimension: MedCPT / SPECTER2 / SciNCL are 768-d BERT-base encoders, while
-- bge-m3 and our fine-tune of it are 1024-d.
--
-- Same shape as sql/08-embeddings.sql, including the ON DELETE CASCADE the
-- build lane added: a withdrawn paper takes every one of its vectors with it.
-- Populated by scripts/embed-nsr/launch.sh with MODEL=/DIM=/EMB_TABLE= set.
-- HNSW indexes are created AFTER each arm's sweep, never before.
BEGIN;

CREATE TABLE IF NOT EXISTS preprint_embeddings_medcpt (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  embedding   vector(768) NOT NULL,            -- ncbi/MedCPT-Article-Encoder
  model       text NOT NULL DEFAULT 'medcpt-article',
  text_hash   text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preprint_embeddings_specter2 (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  embedding   vector(768) NOT NULL,            -- allenai/specter2_base (base, no adapter)
  model       text NOT NULL DEFAULT 'specter2-base',
  text_hash   text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preprint_embeddings_scincl (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  embedding   vector(768) NOT NULL,            -- malteos/scincl
  model       text NOT NULL DEFAULT 'scincl',
  text_hash   text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preprint_embeddings_rxiv (
  key_number  text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  embedding   vector(1024) NOT NULL,           -- our fine-tune of BAAI/bge-m3
  model       text NOT NULL DEFAULT 'rxiv-encoder-bge-m3',
  text_hash   text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
