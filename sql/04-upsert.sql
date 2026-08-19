-- 04: stage_preprints -> preprints + preprint_versions.
--
-- A staged row is a VERSION. The hub keeps the LATEST version per (server, doi);
-- every version is kept in preprint_versions. The ON CONFLICT guard means re-running
-- a walk, or loading overlapping windows, can never regress a paper to an older
-- version — the load is idempotent.
--
-- Everything derived is derived HERE, in SQL, not in the walker: key_number,
-- pub_year, categories[], status_tags, pdf_url.

BEGIN;

CREATE TEMP TABLE s AS
SELECT
  btrim(doi)                                              AS doi,
  substring(btrim(doi) from strpos(btrim(doi), '/') + 1)  AS key_number,
  lower(btrim(server))                                    AS server,
  date::date                                              AS posted_date,
  version::int                                            AS version,
  nullif(btrim(title), '')                                AS title,
  nullif(btrim(authors), '')                              AS authors,
  nullif(btrim(abstract), '')                             AS abstract,
  nullif(btrim(type), '')                                 AS type,
  nullif(btrim(license), '')                              AS license,
  nullif(btrim(category), '')                             AS category,
  nullif(btrim(author_corresponding), '')                 AS author_corresponding,
  nullif(btrim(author_corresponding_institution), '')     AS institution,
  nullif(btrim(jatsxml), '')                              AS jatsxml_url,
  CASE WHEN published IS NULL OR upper(btrim(published)) IN ('', 'NA')
       THEN NULL ELSE btrim(published) END                AS published_doi,
  funder
FROM stage_preprints
WHERE doi IS NOT NULL AND date IS NOT NULL AND version ~ '^[0-9]+$';

-- Collision guard for Decision 1: the bare DOI suffix is the business key, and the
-- two servers' pre-2020 sequences are bare integers that are not provably disjoint.
--
-- This MUST look at the staged rows UNION the rows already in the hub, not the stage
-- alone. When servers are staged separately, a stage-only check is blind to the very
-- case that matters — and because key_number is UNIQUE with ON CONFLICT DO UPDATE, a
-- cross-server suffix clash would not raise: it would quietly overwrite the other
-- server's paper. If this returns rows, the key scheme must become server-qualified.
CREATE TEMP TABLE key_collisions AS
SELECT key_number, count(DISTINCT server) AS servers, array_agg(DISTINCT server) AS which
FROM (
  SELECT key_number, server FROM s
  UNION
  SELECT key_number, server FROM preprints
) u
GROUP BY key_number HAVING count(DISTINCT server) > 1;

INSERT INTO preprints (
  key_number, server, doi, pub_year, posted_date, version, title, authors, abstract,
  type, license, categories, status_tags, author_corresponding, institution,
  jatsxml_url, pdf_url, published_doi, reference, raw)
SELECT DISTINCT ON (server, doi)
  key_number, server, doi,
  EXTRACT(year FROM posted_date)::int,
  posted_date, version, title, authors, abstract, type, license,
  CASE WHEN category IS NULL THEN NULL ELSE ARRAY[category] END,
  ARRAY_REMOVE(ARRAY[
    'v' || version,
    type,
    CASE WHEN published_doi IS NULL THEN 'preprint' ELSE 'published' END,
    license
  ], NULL),
  author_corresponding, institution, jatsxml_url,
  'https://www.' || server || '.org/content/' || doi || 'v' || version || '.full.pdf',
  published_doi,
  -- provisional; sql/05 overwrites this with published_journal wherever pubs has one
  CASE WHEN server = 'biorxiv' THEN 'bioRxiv' ELSE 'medRxiv' END
    || ' (preprint, ' || to_char(posted_date, 'YYYY-MM-DD') || ')',
  jsonb_build_object('funder', CASE WHEN funder IS NULL THEN NULL ELSE funder::jsonb END)
FROM s
ORDER BY server, doi, version DESC
ON CONFLICT (key_number) DO UPDATE SET
  server = EXCLUDED.server, doi = EXCLUDED.doi, pub_year = EXCLUDED.pub_year,
  posted_date = EXCLUDED.posted_date, version = EXCLUDED.version, title = EXCLUDED.title,
  authors = EXCLUDED.authors, abstract = EXCLUDED.abstract, type = EXCLUDED.type,
  license = EXCLUDED.license, categories = EXCLUDED.categories,
  status_tags = EXCLUDED.status_tags, author_corresponding = EXCLUDED.author_corresponding,
  institution = EXCLUDED.institution, jatsxml_url = EXCLUDED.jatsxml_url,
  pdf_url = EXCLUDED.pdf_url, published_doi = EXCLUDED.published_doi,
  reference = EXCLUDED.reference, raw = EXCLUDED.raw
WHERE EXCLUDED.version > preprints.version;

INSERT INTO preprint_versions (key_number, version, posted_date, type, title, authors, abstract, license, jatsxml_url)
SELECT DISTINCT ON (key_number, version)
  key_number, version, posted_date, type, title, authors, abstract, license, jatsxml_url
FROM s
ORDER BY key_number, version
ON CONFLICT (key_number, version) DO NOTHING;

COMMIT;

\echo '--- Decision 1 close-out: cross-server key collisions (must be 0) ---'
SELECT count(*) AS collisions FROM key_collisions;
SELECT * FROM key_collisions LIMIT 10;
\echo '--- identity conservation: one key_number per (server, doi), no silent merges ---'
SELECT count(*)                              AS papers,
       count(DISTINCT key_number)            AS distinct_keys,
       count(DISTINCT (server, doi))         AS distinct_server_doi,
       count(*) - count(DISTINCT key_number) AS key_dupes_must_be_0
FROM preprints;
\echo '--- row counts ---'
SELECT (SELECT count(*) FROM preprints)         AS papers,
       (SELECT count(*) FROM preprint_versions) AS versions,
       (SELECT count(*) FROM stage_preprints)   AS staged;
