-- 28 — XUNDL archive datasets (twin of sql/20 for the xundlarchivals distribution)
-- Loaded by scripts/ingest-xundl-archive.mjs.
--   xundl_archive_files    — ledger of every distribution file mirrored to S3
--   xundl_archive_datasets — one row per XUNDL dataset (full card deck in raw)
--   xundl_refs             — XUNDL <-> NSR literature links (key numbers)
BEGIN;
DROP TABLE IF EXISTS xundl_archive_datasets, xundl_refs, xundl_archive_files;
CREATE TABLE xundl_archive_files (   -- the S3 mirror ledger
  year int NOT NULL, file text NOT NULL, s3_key text NOT NULL, bytes bigint
);
CREATE TABLE xundl_archive_datasets (
  nucid    text NOT NULL,            -- XUNDL NUCID, e.g. '137CS'
  a        int,
  element  text,
  dsid     text NOT NULL,            -- dataset ID string, e.g. 'ADOPTED LEVELS, GAMMAS'
  dsref    text,                     -- keynumber refs from the ID record
  pub      text,                     -- publication field
  entry_date text,                   -- ID-record date field (as-is)
  num_cards int,
  raw      text NOT NULL             -- the dataset's full 80-column card deck
);
CREATE TABLE xundl_refs (            -- XUNDL <-> NSR literature links
  nucid text NOT NULL, dsid text NOT NULL, key_number text NOT NULL
);
COMMIT;
-- after load:
-- CREATE UNIQUE INDEX idx_xundl_ds ON xundl_archive_datasets (nucid, dsid);
-- CREATE INDEX idx_xundl_ds_a ON xundl_archive_datasets (a);   -- NB: idx_xundl_a is taken by sql/18 (ensdf_index)
-- CREATE INDEX idx_xundl_refs_key ON xundl_refs (key_number);
-- CREATE INDEX idx_xundl_refs_ds ON xundl_refs (nucid, dsid);
-- ANALYZE xundl_archive_datasets, xundl_refs, xundl_archive_files;
