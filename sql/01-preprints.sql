-- 01: the CSHL preprint corpus — bioRxiv + medRxiv.
--
-- Hub-and-spokes, straight from LANE-RXIV-MAP.md §6. TABLES AND PRIMARY KEYS ONLY:
-- every secondary index and the generated fts column live in sql/02 and are applied
-- AFTER the bulk load, because merge cost is index maintenance, not COPY.
--
-- Business key is the DOI suffix (Decision 1): '2026.07.31.741992' for modern rows,
-- '001891' / '19000109' for the pre-2020 sequences. It survives the 2026 DOI prefix
-- change (10.1101 -> 10.64898) because the suffix IS the paper id, and it is
-- uppercase-safe (digits and dots only) so /api/record?key= can keep .toUpperCase().
-- UNIQUE (server, doi) is the collision guard the decision asked for.
--
-- A row in the source API is a VERSION, not a paper. The hub holds the LATEST
-- version; the full history lives in preprint_versions, because authors, type and
-- title all drift between versions (v1 carries raw submitted names, v2+ carry
-- normalized 'Last, I.', and 'withdrawn' only ever exists as a later version).

BEGIN;

CREATE TABLE IF NOT EXISTS preprints (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_number           text NOT NULL UNIQUE,
  server               text NOT NULL CHECK (server IN ('biorxiv','medrxiv')),
  doi                  text NOT NULL,
  pub_year             int  NOT NULL,
  posted_date          date NOT NULL,
  version              int  NOT NULL,
  title                text,
  authors              text,
  abstract             text,
  reference            text,
  type                 text,
  license              text,
  categories           text[],
  status_tags          text[],
  author_corresponding text,
  institution          text,
  jatsxml_url          text,
  pdf_url              text,
  published_doi        text,
  published_journal    text,
  published_date       date,
  raw                  jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server, doi)
);

CREATE TABLE IF NOT EXISTS preprint_versions (
  key_number  text NOT NULL,
  version     int  NOT NULL,
  posted_date date,
  type        text,
  title       text,
  authors     text,
  abstract    text,
  license     text,
  jatsxml_url text,
  PRIMARY KEY (key_number, version)
);

-- ── dictionaries ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  category    text PRIMARY KEY,
  servers     text[],
  paper_count int
);

CREATE TABLE IF NOT EXISTS journals (
  journal_name text PRIMARY KEY,
  paper_count  int
);

CREATE TABLE IF NOT EXISTS institutions (
  institution text PRIMARY KEY,
  paper_count int
);

CREATE TABLE IF NOT EXISTS funders (
  funder_key text PRIMARY KEY,   -- coalesce(nullif(ror_id,''), name)
  ror_id     text,
  name       text
);

-- Same column shape as NSR's authors dict so /api/dict?type=authors needs no rewrite.
-- The source gives no author IDs (NSR got authorKey from NNDC), so author_key is a
-- surrogate: a stable hash of the normalized (last_name, initial1, initial2).
CREATE TABLE IF NOT EXISTS authors (
  author_key bigint PRIMARY KEY,
  initial1   text,
  initial2   text,
  last_name  text
);

CREATE TABLE IF NOT EXISTS author_aliases (
  raw_name   text,
  author_key bigint
);

-- ── join tables ─────────────────────────────────────────────────────────────
-- No PK on purpose: these are full-replacement loads (TRUNCATE + COPY), never
-- upsert targets — the same house rule as NSR's sql/13.
CREATE TABLE IF NOT EXISTS preprint_authors (
  key_number  text NOT NULL,
  author_key  bigint NOT NULL,
  order_index int
);

CREATE TABLE IF NOT EXISTS preprint_categories (
  key_number text NOT NULL,
  category   text NOT NULL
);

CREATE TABLE IF NOT EXISTS preprint_funders (
  key_number text NOT NULL,
  funder_key text NOT NULL,
  award      text
);

COMMIT;
