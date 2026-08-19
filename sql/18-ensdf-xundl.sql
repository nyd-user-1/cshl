-- ENSDF evaluation index + XUNDL dataset listings, from NNDC's own servlets.
-- Feeds the /structure pages and the /graph page. Loaded by scripts/ingest-ensdf.mjs;
-- the app reads pre-rendered JSON built from these tables (scripts/build-structure-data.mjs).

BEGIN;

DROP TABLE IF EXISTS ensdf_index, xundl_datasets;

CREATE TABLE ensdf_index (
  row_type   text NOT NULL,       -- 'MASS' | 'NUCLIDE'
  a          int  NOT NULL,
  element    text,                -- NULL for MASS rows
  citation   text,
  cutoff     date,
  xundl_sets int
);

CREATE TABLE xundl_datasets (
  a            int  NOT NULL,     -- mass chain the sweep fetched
  nuclide      text,              -- e.g. '1NN', '137CS' (from the servlet's checkbox value)
  dataset      text NOT NULL,     -- e.g. '1NN B- HALF-LIFE:XUNDL-1'
  last_revised text,              -- 'YYYY-MM'
  recid        bigint             -- NNDC record id, for deep links to getrefs.jsp
);

COMMIT;
-- indexes after load:
-- CREATE INDEX idx_xundl_a ON xundl_datasets (a);
-- CREATE INDEX idx_ensdf_a ON ensdf_index (a);
-- ANALYZE ensdf_index, xundl_datasets;
