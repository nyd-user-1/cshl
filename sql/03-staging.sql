-- 03: staging table for the bulk load. UNLOGGED (no WAL — it is disposable) and it
-- names ONLY source-owned columns, per the house upsert pattern: everything derived
-- (key_number, pub_year, categories[], status_tags, reference) is computed by the
-- upsert in scripts/load-rxiv.mjs, never by the walker.
--
-- All columns are text: the API hands us strings, and casting happens once, in SQL,
-- where a bad value fails loudly instead of silently becoming NULL in JS.

BEGIN;

DROP TABLE IF EXISTS stage_preprints;
CREATE UNLOGGED TABLE stage_preprints (
  doi                              text,
  title                            text,
  authors                          text,
  author_corresponding             text,
  author_corresponding_institution text,
  date                             text,
  version                          text,
  type                             text,
  license                          text,
  category                         text,
  jatsxml                          text,
  abstract                         text,
  published                        text,
  server                           text,
  funder                           text   -- raw JSON array, or the string 'NA'
);

DROP TABLE IF EXISTS stage_pubs;
CREATE UNLOGGED TABLE stage_pubs (
  preprint_doi      text,
  published_doi     text,
  published_journal text,
  published_date    text
);

COMMIT;
