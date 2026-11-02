-- Additive: customer-confirmed dates extracted during setup (and later from pasted documents).
CREATE TABLE workspace_deadlines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX workspace_deadlines_unique ON workspace_deadlines(workspace_id, due_at, title, source_title);
CREATE INDEX workspace_deadlines_due ON workspace_deadlines(workspace_id, due_at);
