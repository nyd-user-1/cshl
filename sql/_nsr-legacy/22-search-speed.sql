-- Graph search speed: key-number prefix lookups get an index (keys are stored
-- uppercase; api/graph now queries LIKE upper(term) so the planner can use it).
CREATE INDEX IF NOT EXISTS idx_nsr_key_number_prefix
  ON nsr (key_number text_pattern_ops);

-- Common FTS terms ('nuclear' matches 199k rows) can't be sorted by fetching
-- every match. With a citation_count btree the planner walks the index
-- top-down and stops at LIMIT for common terms, GIN + sort for rare ones:
-- 21s -> ~20ms either way.
CREATE INDEX IF NOT EXISTS idx_nsr_citation_count_desc
  ON nsr (citation_count DESC NULLS LAST);
