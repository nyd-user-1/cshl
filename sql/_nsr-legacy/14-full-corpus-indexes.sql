-- Secondary indexes for the full-corpus schema. Applied AFTER the bulk load
-- (sql/13 + scripts/load-nsr-dump.mjs) — merge cost is index maintenance, so
-- the loader drops nsr's array/year indexes up front and this recreates them.

BEGIN;

-- ── nsr: recreate what the loader dropped ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nsr_nuclides ON nsr USING gin (nuclides);
CREATE INDEX IF NOT EXISTS idx_nsr_reactions ON nsr USING gin (reactions);
CREATE INDEX IF NOT EXISTS idx_nsr_z_values ON nsr USING gin (z_values);
CREATE INDEX IF NOT EXISTS idx_nsr_pub_year ON nsr (pub_year DESC);

-- redundant with the UNIQUE constraint nsr_key_number_key; retire it
DROP INDEX IF EXISTS idx_nsr_key_number;

-- ── nsr: new columns ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nsr_doi ON nsr (doi) WHERE doi IS NOT NULL; -- enrichment joins
CREATE INDEX IF NOT EXISTS idx_nsr_journal_code ON nsr (journal_code);
CREATE INDEX IF NOT EXISTS idx_nsr_reference_type ON nsr (reference_type);
CREATE INDEX IF NOT EXISTS idx_nsr_entry_date ON nsr (entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_nsr_subjects ON nsr USING gin (subjects);
CREATE INDEX IF NOT EXISTS idx_nsr_topics ON nsr USING gin (topics);

-- ── join tables ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nsr_authors_key ON nsr_authors (key_number);
CREATE INDEX IF NOT EXISTS idx_nsr_authors_author ON nsr_authors (author_key);
CREATE INDEX IF NOT EXISTS idx_nsr_nuclides_key ON nsr_nuclides (key_number);
CREATE INDEX IF NOT EXISTS idx_nsr_nuclides_za ON nsr_nuclides (z, a);
CREATE INDEX IF NOT EXISTS idx_nsr_reactions_key ON nsr_reactions (key_number);
CREATE INDEX IF NOT EXISTS idx_nsr_reactions_code ON nsr_reactions (reaction_code);
CREATE INDEX IF NOT EXISTS idx_nsr_subjects_key ON nsr_subjects (key_number);
CREATE INDEX IF NOT EXISTS idx_nsr_subjects_code ON nsr_subjects (subject_code);
CREATE INDEX IF NOT EXISTS idx_nsr_topics_key ON nsr_topics (key_number);
CREATE INDEX IF NOT EXISTS idx_nsr_topics_topic ON nsr_topics (topic);
CREATE INDEX IF NOT EXISTS idx_nsr_mass_ranges_key ON nsr_mass_ranges (key_number);
CREATE INDEX IF NOT EXISTS idx_nsr_z_ranges_key ON nsr_z_ranges (key_number);

-- ── dictionaries ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_authors_last_name ON authors (last_name);
CREATE INDEX IF NOT EXISTS idx_author_aliases_key ON author_aliases (author_key);

COMMIT;

ANALYZE nsr, nsr_authors, nsr_nuclides, nsr_reactions, nsr_subjects, nsr_topics,
        nsr_mass_ranges, nsr_z_ranges, authors, author_aliases, journals,
        nuclide_dict, particle_dict, subject_dict, reaction_dict,
        reaction_display, decay_processes, collaboration_names;
