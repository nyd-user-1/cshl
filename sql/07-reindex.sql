-- 07: a REAL index rebuild for after the bulk load.
--
-- sql/02 is CREATE INDEX IF NOT EXISTS — correct for a first run, a silent no-op on
-- every run after. Indexes built before a large load are maintained incrementally
-- and end up bloated with a fragmented physical layout, and the planner is working
-- from stale statistics. REINDEX rebuilds each one from the heap; ANALYZE refreshes
-- the statistics that /api/records' unfiltered pager reads out of pg_class.reltuples.
--
-- Not CONCURRENTLY: nothing else is serving this database during the load window,
-- and the plain form is substantially faster.

\echo '--- index sizes BEFORE rebuild ---'
SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE relname IN ('preprints','preprint_versions','preprint_authors','preprint_categories')
ORDER BY pg_relation_size(indexrelid) DESC;

REINDEX TABLE preprints;
REINDEX TABLE preprint_versions;
REINDEX TABLE preprint_authors;
REINDEX TABLE preprint_categories;
REINDEX TABLE preprint_funders;
REINDEX TABLE authors;
REINDEX TABLE categories;
REINDEX TABLE journals;
REINDEX TABLE institutions;

ANALYZE preprints;
ANALYZE preprint_versions;
ANALYZE preprint_authors;
ANALYZE preprint_categories;
ANALYZE preprint_funders;
ANALYZE authors;
ANALYZE categories;
ANALYZE journals;
ANALYZE institutions;

\echo '--- index sizes AFTER rebuild ---'
SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE relname IN ('preprints','preprint_versions','preprint_authors','preprint_categories')
ORDER BY pg_relation_size(indexrelid) DESC;

\echo '--- reltuples the pager reads (must be close to the real count) ---'
SELECT (SELECT reltuples::bigint FROM pg_class WHERE relname='preprints') AS reltuples,
       (SELECT count(*) FROM preprints) AS actual;
