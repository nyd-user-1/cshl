-- 23: resolved preprint -> published-version links.
--
-- WHY THIS TABLE EXISTS. `preprints.published_doi` is null for 50.3% of the
-- corpus (218,041 of 433,449), and that is NOT staleness on our side: for the
-- CRISPR test paper, bioRxiv's own API reports `published: "NA"` on every
-- version and /pubs/ answers "no articles found for published version", while
-- the paper has in fact been in Genome Biology since 2021-09-30
-- (10.1186/s13059-021-02495-9). Crossref's `relation` field, the standard
-- bridge, is empty for it too. No identifier anywhere links the two objects —
-- a preprint and its version of record are separately registered DOIs.
--
-- So the link has to be REDISCOVERED from content (see api/_lib/dossier.ts:
-- author + topic search on OpenAlex, scored by author-surname and abstract
-- overlap). That costs a network round trip and can be wrong, which is exactly
-- why the result is written down here with its score and method rather than
-- recomputed per turn.
--
-- `preprints` is never written to. `confidence` is kept so a later pass can
-- raise the bar without re-resolving, and `status` records a searched-and-found
-- -nothing result so we do not re-pay for the misses.

CREATE TABLE IF NOT EXISTS preprint_published_match (
  key_number      text PRIMARY KEY REFERENCES preprints(key_number) ON DELETE CASCADE,
  status          text NOT NULL,              -- 'matched' | 'none' | 'error'
  published_doi   text,
  published_journal text,
  published_year  integer,
  published_title text,
  pmcid           text,
  confidence      real,                       -- 0..1, see scoreCandidate()
  method          text,                       -- 'db' | 'openalex' | 'crossref-relation'
  resolved_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ppm_status ON preprint_published_match (status);
