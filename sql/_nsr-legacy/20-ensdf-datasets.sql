-- ENSDF archival mirror + the current snapshot, parsed dataset-by-dataset.
-- Loaded by scripts/ingest-ensdf-archive.mjs.
--   ensdf_archive_files — ledger of every distribution file mirrored to S3
--   ensdf_datasets      — one row per ENSDF dataset, with its full card deck
--   ensdf_refs          — ENSDF dataset -> NSR key-number links (the literature join)

BEGIN;
DROP TABLE IF EXISTS ensdf_datasets, ensdf_refs, ensdf_archive_files;
CREATE TABLE ensdf_archive_files (   -- the S3 mirror ledger
  year int NOT NULL, file text NOT NULL, s3_key text NOT NULL, bytes bigint
);
CREATE TABLE ensdf_datasets (
  nucid    text NOT NULL,            -- ENSDF NUCID, e.g. '137CS'
  a        int,
  element  text,
  dsid     text NOT NULL,            -- dataset ID string, e.g. 'ADOPTED LEVELS, GAMMAS'
  dsref    text,                     -- keynumber refs from the ID record
  pub      text,                     -- publication field
  entry_date text,                   -- ID-record date field (as-is)
  num_cards int,
  raw      text NOT NULL             -- the dataset's full 80-column card deck
);
CREATE TABLE ensdf_refs (            -- ENSDF <-> NSR literature links
  nucid text NOT NULL, dsid text NOT NULL, key_number text NOT NULL
);
COMMIT;
-- after load:
-- CREATE UNIQUE INDEX idx_ensdf_ds ON ensdf_datasets (nucid, dsid);
-- CREATE INDEX idx_ensdf_ds_a ON ensdf_datasets (a);   -- NB: idx_ensdf_a is taken by sql/18 (ensdf_index)
-- CREATE INDEX idx_ensdf_refs_key ON ensdf_refs (key_number);
-- CREATE INDEX idx_ensdf_refs_ds ON ensdf_refs (nucid, dsid);
-- ANALYZE ensdf_datasets, ensdf_refs, ensdf_archive_files;
