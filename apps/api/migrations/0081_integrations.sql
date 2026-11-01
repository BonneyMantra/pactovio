-- Workspace-owned metadata only. Provider credentials remain in Composio.
CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  toolkit TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','active','error','disconnected')),
  attempt_hash TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, toolkit)
);
CREATE UNIQUE INDEX integration_account_owner ON integration_connections(account_id) WHERE account_id IS NOT NULL;
CREATE TABLE integration_oauth_states (
  state_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT NOT NULL REFERENCES customer_sessions(id),
  toolkit TEXT NOT NULL,
  account_id TEXT,
  auth_scheme TEXT NOT NULL,
  origin TEXT NOT NULL,
  return_path TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE integration_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  connection_id TEXT REFERENCES integration_connections(id),
  account_id TEXT,
  toolkit TEXT NOT NULL,
  adapter TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'selected',
  revision INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT NOT NULL DEFAULT 'null',
  exhausted INTEGER NOT NULL DEFAULT 0,
  read_token TEXT,
  lease_until INTEGER,
  preview_json TEXT,
  preview_hash TEXT,
  approval_key TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX integration_jobs_workspace ON integration_jobs(workspace_id, created_at);
CREATE TABLE integration_staging (
  job_id TEXT NOT NULL REFERENCES integration_jobs(id),
  external_id TEXT NOT NULL,
  source_version TEXT,
  retrieved_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id, external_id)
);
CREATE TABLE integration_product_versions (
  product_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);
-- Triggers have one statement each so the existing migration harness remains compatible.
CREATE TRIGGER integration_product_insert AFTER INSERT ON products BEGIN INSERT INTO integration_product_versions(product_id, revision) VALUES(NEW.id, 1) ON CONFLICT(product_id) DO UPDATE SET revision = revision + 1; END;
CREATE TRIGGER integration_product_update AFTER UPDATE ON products BEGIN INSERT INTO integration_product_versions(product_id, revision) VALUES(NEW.id, 1) ON CONFLICT(product_id) DO UPDATE SET revision = revision + 1; END;
CREATE TRIGGER integration_product_delete AFTER DELETE ON products BEGIN UPDATE integration_product_versions SET revision = revision + 1 WHERE product_id = OLD.id; END;
CREATE TABLE integration_provenance (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  account_id TEXT,
  resource_json TEXT NOT NULL,
  source_version TEXT,
  retrieved_at TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_revision INTEGER NOT NULL,
  resolution_json TEXT NOT NULL DEFAULT '{}',
  preview_hash TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES integration_jobs(id),
  PRIMARY KEY(workspace_id, source_key, external_id),
  UNIQUE(workspace_id, product_id)
);
-- A failed optimistic precondition aborts the entire D1 batch, including earlier writes.
CREATE TABLE integration_transaction_guard (token TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid = 1));
CREATE TABLE integration_approval_receipts (
  job_id TEXT NOT NULL REFERENCES integration_jobs(id),
  idempotency_key TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  frozen_preview_json TEXT NOT NULL,
  PRIMARY KEY(job_id, idempotency_key)
);
