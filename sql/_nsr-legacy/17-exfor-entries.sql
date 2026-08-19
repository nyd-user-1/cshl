-- EXFOR layer, rebuilt from IAEA-NDS/exfor_json (supersedes sql/04-exfor-entries.sql).
-- Loaded by scripts/ingest-exfor.mjs. Both tables are owned outright by that
-- script: DROP + CREATE + full reload, never incremental.
BEGIN;
DROP TABLE IF EXISTS exfor_entries, nsr_exfor;
CREATE TABLE exfor_entries (
  exfor_id        text PRIMARY KEY,   -- 5-char accession number, e.g. '22742', 'C1234'
  title           text,
  year            int,
  authors         text,               -- '; '-joined, NSR style
  institutes      jsonb,
  reactions       jsonb,              -- the REACTION codes across subentries
  num_subentries  int,
  raw             jsonb NOT NULL      -- the full entry JSON
);
CREATE TABLE nsr_exfor (
  key_number text NOT NULL,           -- NSR entry
  exfor_id   text NOT NULL
);
COMMIT;

-- INDEXES — applied AFTER the load (P4), not before.
-- CREATE INDEX idx_nsr_exfor_key ON nsr_exfor (key_number);
-- CREATE INDEX idx_nsr_exfor_exfor ON nsr_exfor (exfor_id);
-- ANALYZE exfor_entries, nsr_exfor;
