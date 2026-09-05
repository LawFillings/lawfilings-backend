-- Migration 009: track real per-lookup cause-list usage
-- Real extraction testing during development burned through paid API credits fast, and there was
-- no way to see afterward which courts/requests actually drove that cost — only Anthropic's own
-- usage dashboard, which isn't broken down by court or advocate. This logs enough per-request data
-- (which court, which model, real token counts) to work out actual per-advocate/per-court cost
-- once this is live, without needing another paid dry run just to find out.

CREATE TABLE cause_list_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  court_id TEXT NOT NULL,
  causelist_date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('fetch', 'upload')),
  scope TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  entries_count INTEGER,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cause_list_usage_court_id_idx ON cause_list_usage (court_id);
CREATE INDEX cause_list_usage_user_id_idx ON cause_list_usage (user_id);
CREATE INDEX cause_list_usage_created_at_idx ON cause_list_usage (created_at);
