-- 10: an exact, cheap corpus count for the pager.
--
-- /api/records showed the unfiltered total from pg_class.reltuples — free, and the
-- right call on NSR. Measured here after the load: reltuples 438,515 vs an actual
-- 433,449, a 1.17% overstatement. That is fine for query planning and wrong for a
-- number a human reads: the pager would offer pages that don't exist, and the figure
-- would disagree with every count in the report.
--
-- An exact count(*) is correct but ~800 ms on 433k rows — acceptable behind the
-- hour-long edge cache, poor on a cold one. So the count is materialized once at load
-- time, where it is free, and read as a single row at request time.
--
-- Refreshed by sql/05-derive.sql on every load. If the row is missing, /api/records
-- falls back to reltuples rather than failing.
BEGIN;

CREATE TABLE IF NOT EXISTS corpus_stats (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  papers      int NOT NULL,
  versions    int NOT NULL,
  biorxiv     int NOT NULL,
  medrxiv     int NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO corpus_stats (id, papers, versions, biorxiv, medrxiv, refreshed_at)
SELECT 1,
       (SELECT count(*)::int FROM preprints),
       (SELECT count(*)::int FROM preprint_versions),
       (SELECT count(*)::int FROM preprints WHERE server = 'biorxiv'),
       (SELECT count(*)::int FROM preprints WHERE server = 'medrxiv'),
       now()
ON CONFLICT (id) DO UPDATE SET
  papers = EXCLUDED.papers, versions = EXCLUDED.versions,
  biorxiv = EXCLUDED.biorxiv, medrxiv = EXCLUDED.medrxiv,
  refreshed_at = EXCLUDED.refreshed_at;

COMMIT;

SELECT * FROM corpus_stats;
