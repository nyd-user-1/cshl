-- 02: indexes + the generated fts column. APPLIED AFTER THE BULK LOAD, never before.
--
-- fts weighting (LANE-RXIV-MAP.md §4): NSR put its expert keyword abstracts in the B
-- slot. This corpus has no analog, so B is the three fields that behave like controlled
-- vocabulary here — category, the publishing journal, and the corresponding
-- institution. Title stays A, abstract stays C, same as sql/_nsr-legacy/19.

BEGIN;

ALTER TABLE preprints ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    -- NB: array_to_string() is STABLE, not IMMUTABLE, so it cannot appear in a
    -- generated column. The source assigns exactly one category per preprint, so
    -- the scalar subscript carries the same information and is immutable.
    setweight(to_tsvector('english',
        coalesce(categories[1], '') || ' ' ||
        coalesce(published_journal, '') || ' ' ||
        coalesce(institution, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(abstract, ''), 4000)), 'C')
  ) STORED;

COMMIT;

CREATE INDEX IF NOT EXISTS idx_pp_fts        ON preprints USING gin (fts);
CREATE INDEX IF NOT EXISTS idx_pp_categories ON preprints USING gin (categories);
CREATE INDEX IF NOT EXISTS idx_pp_status     ON preprints USING gin (status_tags);
CREATE INDEX IF NOT EXISTS idx_pp_year       ON preprints (pub_year DESC);
CREATE INDEX IF NOT EXISTS idx_pp_key        ON preprints (key_number);
CREATE INDEX IF NOT EXISTS idx_pp_server     ON preprints (server);
CREATE INDEX IF NOT EXISTS idx_pp_published  ON preprints (published_doi) WHERE published_doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_title_trgm ON preprints USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ppv_key       ON preprint_versions (key_number);
CREATE INDEX IF NOT EXISTS idx_ppa_key       ON preprint_authors (key_number);
CREATE INDEX IF NOT EXISTS idx_ppa_author    ON preprint_authors (author_key);
CREATE INDEX IF NOT EXISTS idx_ppc_key       ON preprint_categories (key_number);
CREATE INDEX IF NOT EXISTS idx_ppc_cat       ON preprint_categories (category);
CREATE INDEX IF NOT EXISTS idx_ppf_key       ON preprint_funders (key_number);
CREATE INDEX IF NOT EXISTS idx_authors_last  ON authors (last_name);

ANALYZE preprints;
ANALYZE preprint_versions;
ANALYZE preprint_authors;
ANALYZE preprint_categories;
