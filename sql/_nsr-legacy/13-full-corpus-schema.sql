-- Full-corpus schema: widen nsr and add the relational tables that mirror the
-- NNDC dump's own structure (tables/ + dictionaries/ + radioactivity/).
--
-- Tables and PRIMARY KEYs ONLY. Every secondary index lives in
-- sql/14-full-corpus-indexes.sql and is applied AFTER the bulk load — merge
-- cost is index maintenance, not COPY.
--
-- Join tables have no PK on purpose: they are full-replacement loads
-- (TRUNCATE + COPY), never upsert targets.

BEGIN;

-- 24,638 dump entries genuinely have no title (mostly pre-1970); store the truth.
ALTER TABLE nsr ALTER COLUMN title DROP NOT NULL;

ALTER TABLE nsr
  ADD COLUMN IF NOT EXISTS reference_type text,
  ADD COLUMN IF NOT EXISTS journal_code text,
  ADD COLUMN IF NOT EXISTS index_information text,
  ADD COLUMN IF NOT EXISTS coden_text text,
  ADD COLUMN IF NOT EXISTS entry_date date,
  ADD COLUMN IF NOT EXISTS modification_date date,
  ADD COLUMN IF NOT EXISTS is_primary boolean,
  ADD COLUMN IF NOT EXISTS pdf_available boolean,
  ADD COLUMN IF NOT EXISTS xundl_available boolean,
  ADD COLUMN IF NOT EXISTS collaborations jsonb,
  ADD COLUMN IF NOT EXISTS authors_json jsonb,
  ADD COLUMN IF NOT EXISTS sentence_groups jsonb,
  ADD COLUMN IF NOT EXISTS subjects text[],
  ADD COLUMN IF NOT EXISTS topics text[],
  ADD COLUMN IF NOT EXISTS raw jsonb;

-- ── Dictionaries ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journals (
  journal_code text PRIMARY KEY,
  title        text,
  min_year     int,
  max_year     int
);

CREATE TABLE IF NOT EXISTS nuclide_dict (
  nuclide_code text PRIMARY KEY,
  z            int,
  n            int,
  a            int,
  element      text
);

CREATE TABLE IF NOT EXISTS particle_dict (
  particle_code text PRIMARY KEY,
  z             int,
  a             int
);

CREATE TABLE IF NOT EXISTS subject_dict (
  subject_code text PRIMARY KEY,
  description  text
);

-- authorKey is unique across single-author-names (verified 2026-08-16);
-- collaborations share the same key space but live in their own table.
CREATE TABLE IF NOT EXISTS authors (
  author_key bigint PRIMARY KEY,
  initial1   text,
  initial2   text,
  last_name  text
);

CREATE TABLE IF NOT EXISTS author_aliases (
  initial1   text,
  initial2   text,
  last_name  text,
  author_key bigint
);

CREATE TABLE IF NOT EXISTS collaboration_names (
  collaboration_name text,
  author_key         bigint,
  is_alias           boolean DEFAULT false
);

-- radioactivity/: canonical reaction decomposition + decay processes
CREATE TABLE IF NOT EXISTS reaction_dict (
  reaction_code           text PRIMARY KEY,
  incident_particle       text,
  outgoing_particles      jsonb,
  is_alpha_transfer       boolean,
  is_fission              boolean,
  is_polarized            boolean,
  is_two_nucleon_transfer boolean,
  is_charge_exchange      boolean,
  is_determinable         boolean,
  delta_z                 int,
  delta_n                 int,
  delta_a                 int
);

-- display forms per reaction code (NSR exchange format + LaTeX)
CREATE TABLE IF NOT EXISTS reaction_display (
  reaction_code  text PRIMARY KEY,
  exchange_codes jsonb,
  latex_codes    jsonb
);

CREATE TABLE IF NOT EXISTS decay_processes (
  subject_code text PRIMARY KEY,
  delta_z      int,
  delta_n      int,
  delta_a      int,
  latex_code   text
);

-- ── Join tables (entry ↔ dictionary), straight from tables/*.jsonl ──────────

CREATE TABLE IF NOT EXISTS nsr_authors (
  key_number  text NOT NULL,
  author_key  bigint NOT NULL,
  order_index int
);

CREATE TABLE IF NOT EXISTS nsr_nuclides (
  key_number     text NOT NULL,
  z              int,
  n              int,
  a              int,
  element_symbol text,
  element_name   text,
  sub_type       text,
  selector_flag  text,
  selector_index int
);

CREATE TABLE IF NOT EXISTS nsr_reactions (
  key_number     text NOT NULL,
  reaction_code  text,
  selector_flag  text,
  selector_index int
);

CREATE TABLE IF NOT EXISTS nsr_subjects (
  key_number     text NOT NULL,
  subject_code   text,
  sub_type       text,
  selector_flag  text,
  selector_index int
);

CREATE TABLE IF NOT EXISTS nsr_topics (
  key_number text NOT NULL,
  topic      text
);

CREATE TABLE IF NOT EXISTS nsr_mass_ranges (
  key_number     text NOT NULL,
  minimum        int,
  maximum        int,
  selector_flag  text,
  selector_index int
);

CREATE TABLE IF NOT EXISTS nsr_z_ranges (
  key_number     text NOT NULL,
  minimum        int,
  maximum        int,
  selector_flag  text,
  selector_index int
);

COMMIT;
