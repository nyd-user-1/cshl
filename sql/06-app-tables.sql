-- 06: app-infrastructure tables — corpus-independent, carried over from the NSR era
-- unchanged. These store app events and user-authored content, not nuclear data, so
-- they transfer to the preprint corpus verbatim. Without them /api/feed,
-- /api/community and /api/chat-sessions 500 on page load.

BEGIN;

CREATE TABLE IF NOT EXISTS research_feed (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL,
  category     text NOT NULL DEFAULT 'activity',
  entity_type  text,
  entity_value text,
  display_text text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_feed_created_at ON research_feed (created_at DESC);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_views (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  description text,
  saved_by    text NOT NULL DEFAULT 'anonymous',
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS community_threads (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      text NOT NULL,
  author     text NOT NULL,
  entity_ref text,               -- now 'preprint:2026.07.31.741992' | 'category:oncology'
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
  status     text NOT NULL DEFAULT 'new',
  severity   int  NOT NULL DEFAULT 3,
  assignee   text,
  entity_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
