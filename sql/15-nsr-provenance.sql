-- Provenance: the corpus is about to grow beyond official NSR (APS feeds,
-- arXiv, S2, OpenAlex, ...). Official NSR entries get a permanent flag so
-- they stay disambiguable no matter how many sources land later.
--
-- DEFAULT false on purpose: future ingests from other sources must never be
-- able to masquerade as NSR by forgetting to set a column.

BEGIN;

ALTER TABLE nsr ADD COLUMN IF NOT EXISTS is_nsr boolean NOT NULL DEFAULT false;

-- everything currently in the table came from the NNDC dump (or the Feb load
-- of the same corpus) — all official NSR
UPDATE nsr SET is_nsr = true WHERE NOT is_nsr;

CREATE INDEX IF NOT EXISTS idx_nsr_is_nsr ON nsr (is_nsr) WHERE NOT is_nsr;

COMMIT;
