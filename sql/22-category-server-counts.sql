-- 22: per-server category counts, materialized (LANE-MEDRXIV-ROOMS §5.1).
--
-- The room cards need "how many medRxiv papers are in this category". The
-- `categories` table's paper_count is CROSS-SERVER, which lies for every
-- category both servers use, and computing it live is an unnest + GROUP BY
-- over 87,567 medRxiv rows: measured 3.1 s cold on the deployed function.
-- Edge caching hides that from all but the first request after each expiry,
-- and "one user a day waits three seconds" still fails the under-1-second
-- constraint. So it is precomputed here and read as a ~100-row lookup.
--
-- Refresh after any corpus load:
--   psql "$DATABASE_URL" -f sql/22-category-server-counts.sql

CREATE TABLE IF NOT EXISTS category_server_counts (
  server      text NOT NULL,
  category    text NOT NULL,
  paper_count integer NOT NULL,
  PRIMARY KEY (server, category)
);

TRUNCATE category_server_counts;

INSERT INTO category_server_counts (server, category, paper_count)
SELECT p.server, c.category, count(*)::int
FROM preprints p, unnest(p.categories) c(category)
WHERE p.server IS NOT NULL
GROUP BY 1, 2;
