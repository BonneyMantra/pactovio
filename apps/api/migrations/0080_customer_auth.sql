-- Additive customer identity storage. Existing judge sessions and sample data remain intact.
CREATE TABLE customer_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  verified_at TEXT NOT NULL
);
CREATE TABLE workspace_members (
  user_id TEXT NOT NULL REFERENCES customer_users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','member')),
  PRIMARY KEY(user_id, workspace_id)
);
CREATE TABLE customer_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES customer_users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX customer_session_user ON customer_sessions(user_id);
CREATE TABLE email_codes (
  email TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER
);
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  resets_at INTEGER NOT NULL
);
CREATE TABLE company_onboarding (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  data_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE connector_oauth_states (
  state_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL REFERENCES customer_sessions(id),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX oauth_state_expiry ON connector_oauth_states(expires_at);
