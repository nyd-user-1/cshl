-- Workspace layer: community-owned saved views, discussions, issues.
-- NO auth by design (ruling 2026-08-16): everything is community-visible,
-- authorship is a free-text display name. Seeded with dummy content so the
-- collaboration surfaces render real structure from day one.

BEGIN;

CREATE TABLE IF NOT EXISTS workspace_views (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  description text,
  saved_by   text NOT NULL DEFAULT 'anonymous',
  state      jsonb NOT NULL,     -- graph state: nodes (type,id,x,y), edges
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_threads (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL,
  author     text NOT NULL,
  entity_ref text,               -- 'nuclide:137CS' | 'paper:2024BA01' | 'chain:137' | null
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_posts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id  bigint NOT NULL,
  author     text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_issues (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL,
  body       text,
  status     text NOT NULL DEFAULT 'new',   -- new | ack | assigned | resolved
  severity   int  NOT NULL DEFAULT 3,       -- 1 (worst) .. 5
  assignee   text,
  entity_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── dummy seeds ─────────────────────────────────────────────────────────────
INSERT INTO community_threads (title, author, entity_ref) VALUES
  ('A=137 evaluation is 19 years stale — worth flagging upstream?', 'B. Stanton', 'chain:137'),
  ('Best starting corpus for (n,γ) capture systematics?', 'R. Firestone', 'reaction:(N,G)'),
  ('XUNDL vs adopted levels for 137Ba — which wins for teaching?', 'A. Sonzogni', 'nuclide:137BA');

INSERT INTO community_posts (thread_id, author, body) VALUES
  (1, 'B. Stanton', 'The mass-chain cutoff is 2006-10-01 and there are 30+ XUNDL sets since. This is exactly the kind of chain the evaluation index should surface first.'),
  (1, 'K. Kondev', 'Agreed — note the In-137 nuclide re-evaluation (2015) partially covers it. The rest of the chain is genuinely stale.'),
  (2, 'R. Firestone', 'CapGam covers thermal capture; for systematics I''d pull every (N,G) paper with a measured sigma and cross-check against the EXFOR links.'),
  (3, 'A. Sonzogni', 'Adopted levels for pedagogy, XUNDL when you need what a specific experiment actually saw.');

INSERT INTO community_issues (title, body, status, severity, assignee, entity_ref) VALUES
  ('137Cs decay radiations table cites superseded half-life', 'Half-life shown traces to 1968RE04; newer measurements exist in the corpus. Reconcile before quoting.', 'assigned', 2, 'M. Verpelli', 'nuclide:137CS'),
  ('Duplicate DOI rows for PLB chain papers', 'Two key numbers share 10.1016/j.physletb.2026.140362 — likely erratum pair, needs classification.', 'ack', 3, NULL, NULL),
  ('A=100 chain missing XUNDL link-through', 'Evaluation index shows 12 sets since cutoff but the chain page lists none.', 'new', 3, NULL, 'chain:100'),
  ('Graph: author expansion slow past 500 papers', 'Pagination works but the fan-out layout gets crowded — consider clustering by decade.', 'new', 4, 'B. Stanton', NULL),
  ('Adopted gammas for 137Ba missing mixing ratios', 'Present in source ENSDF dataset, dropped somewhere in ingest.', 'resolved', 2, 'J. Chen', 'nuclide:137BA');

COMMIT;

CREATE INDEX IF NOT EXISTS idx_posts_thread ON community_posts (thread_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON community_issues (status);
