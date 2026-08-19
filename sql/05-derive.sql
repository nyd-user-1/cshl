-- 05: the relational layer — dictionaries, join tables, and the pubs application.
-- Runs AFTER sql/04. Join tables are full-replacement loads (TRUNCATE + INSERT),
-- never upsert targets, same house rule as NSR's sql/13.

BEGIN;

-- ── pubs: the only source of the journal NAME, and the Reference card slot ───
UPDATE preprints p SET
  published_journal = j.published_journal,
  published_date    = j.published_date,
  published_doi     = coalesce(p.published_doi, j.published_doi)
FROM (
  SELECT DISTINCT ON (btrim(preprint_doi))
         btrim(preprint_doi)                  AS preprint_doi,
         nullif(btrim(published_journal), '') AS published_journal,
         nullif(btrim(published_doi), '')     AS published_doi,
         CASE WHEN published_date ~ '^\d{4}-\d{2}-\d{2}$' THEN published_date::date END AS published_date
  FROM stage_pubs
  ORDER BY btrim(preprint_doi), published_date DESC NULLS LAST
) j
WHERE p.doi = j.preprint_doi;

-- Reference slot: the journal citation when the preprint was published, else the
-- server + posting date. NsrRecordCard strips a trailing "(YYYY)" for display, so
-- the published form deliberately ends in the year, exactly like NSR's citations.
UPDATE preprints SET reference =
  CASE WHEN published_journal IS NOT NULL
       THEN published_journal || ' (' || coalesce(EXTRACT(year FROM published_date)::int, pub_year) || ')'
       ELSE (CASE WHEN server = 'biorxiv' THEN 'bioRxiv' ELSE 'medRxiv' END)
            || ' (preprint, ' || to_char(posted_date, 'YYYY-MM-DD') || ')' END;

-- status_tags gains the published/preprint truth now that pubs has landed
UPDATE preprints SET status_tags =
  ARRAY_REMOVE(ARRAY['v' || version, type,
                     CASE WHEN published_doi IS NULL THEN 'preprint' ELSE 'published' END,
                     license], NULL);

-- ── dictionaries ────────────────────────────────────────────────────────────
TRUNCATE categories;
INSERT INTO categories (category, servers, paper_count)
SELECT c, array_agg(DISTINCT server ORDER BY server), count(*)::int
FROM preprints, unnest(categories) AS c GROUP BY c;

TRUNCATE journals;
INSERT INTO journals (journal_name, paper_count)
SELECT published_journal, count(*)::int FROM preprints
WHERE published_journal IS NOT NULL GROUP BY published_journal;

TRUNCATE institutions;
INSERT INTO institutions (institution, paper_count)
SELECT institution, count(*)::int FROM preprints
WHERE institution IS NOT NULL GROUP BY institution;

-- ── authors: parsed out of the already-normalized '; '-joined display string ──
-- The loader has guaranteed every name is 'Last, I. M.' by this point, so the dict
-- can be derived in SQL. author_key is a surrogate (the source has no author IDs).
CREATE TEMP TABLE parsed_authors AS
SELECT p.key_number, t.ord::int AS order_index,
       btrim(split_part(t.tok, ',', 1))                                          AS last_name,
       upper(substring(btrim(split_part(t.tok, ',', 2)) from '^([[:alpha:]])'))   AS initial1,
       upper(substring(btrim(split_part(t.tok, ',', 2)) from '^[[:alpha:]][.]?[[:space:]]+([[:alpha:]])')) AS initial2
FROM preprints p,
     unnest(string_to_array(p.authors, ';')) WITH ORDINALITY AS t(tok, ord)
WHERE p.authors IS NOT NULL AND btrim(t.tok) <> '';

ALTER TABLE parsed_authors ADD COLUMN author_key bigint;
UPDATE parsed_authors SET author_key =
  abs(hashtextextended(lower(coalesce(last_name,'')) || '|' || lower(coalesce(initial1,'')) || '|' || lower(coalesce(initial2,'')), 0));

TRUNCATE authors;
INSERT INTO authors (author_key, initial1, initial2, last_name)
SELECT DISTINCT ON (author_key) author_key, initial1, initial2, last_name
FROM parsed_authors WHERE last_name <> '' ORDER BY author_key;

TRUNCATE preprint_authors;
INSERT INTO preprint_authors (key_number, author_key, order_index)
SELECT key_number, author_key, order_index FROM parsed_authors WHERE last_name <> '';

-- ── join tables ─────────────────────────────────────────────────────────────
TRUNCATE preprint_categories;
INSERT INTO preprint_categories (key_number, category)
SELECT key_number, c FROM preprints, unnest(categories) AS c;

TRUNCATE funders;
INSERT INTO funders (funder_key, ror_id, name)
SELECT DISTINCT ON (fk) fk, ror, nm FROM (
  SELECT coalesce(nullif(btrim(f->>'id'), ''), btrim(f->>'name')) AS fk,
         nullif(btrim(f->>'id'), '') AS ror, btrim(f->>'name') AS nm
  FROM preprints p, jsonb_array_elements(p.raw->'funder') AS f
  WHERE jsonb_typeof(p.raw->'funder') = 'array'
) x WHERE fk IS NOT NULL AND fk <> '' ORDER BY fk;

TRUNCATE preprint_funders;
INSERT INTO preprint_funders (key_number, funder_key, award)
SELECT DISTINCT p.key_number,
       coalesce(nullif(btrim(f->>'id'), ''), btrim(f->>'name')),
       nullif(btrim(f->>'award'), '')
FROM preprints p, jsonb_array_elements(p.raw->'funder') AS f
WHERE jsonb_typeof(p.raw->'funder') = 'array'
  AND coalesce(nullif(btrim(f->>'id'), ''), btrim(f->>'name')) <> '';

-- keep the pager's exact total in step with the load (sql/10)
INSERT INTO corpus_stats (id, papers, versions, biorxiv, medrxiv, refreshed_at)
SELECT 1, (SELECT count(*)::int FROM preprints), (SELECT count(*)::int FROM preprint_versions),
       (SELECT count(*)::int FROM preprints WHERE server='biorxiv'),
       (SELECT count(*)::int FROM preprints WHERE server='medrxiv'), now()
ON CONFLICT (id) DO UPDATE SET papers=EXCLUDED.papers, versions=EXCLUDED.versions,
  biorxiv=EXCLUDED.biorxiv, medrxiv=EXCLUDED.medrxiv, refreshed_at=EXCLUDED.refreshed_at;

COMMIT;

\echo '--- dictionary sizes ---'
SELECT (SELECT count(*) FROM categories)   AS categories,
       (SELECT count(*) FROM journals)     AS journals,
       (SELECT count(*) FROM institutions) AS institutions,
       (SELECT count(*) FROM funders)      AS funders,
       (SELECT count(*) FROM authors)      AS authors;
SELECT (SELECT count(*) FROM preprint_authors)    AS pp_authors,
       (SELECT count(*) FROM preprint_categories) AS pp_categories,
       (SELECT count(*) FROM preprint_funders)    AS pp_funders,
       (SELECT count(*) FROM preprints WHERE published_journal IS NOT NULL) AS with_journal;
