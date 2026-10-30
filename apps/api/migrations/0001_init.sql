-- Pactovio D1 schema (BUILD-BRIEF section 3). Money = integer minor units, except tenders.value_eur (whole euros, mirrors TED).
-- Later lanes add migrations in their own number ranges (0010-0079).
PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT NOT NULL CHECK (segment IN ('it','industrial')),
  profile_json TEXT NOT NULL DEFAULT '{}',
  sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE judge_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  created_at TEXT NOT NULL,
  runs_used INTEGER NOT NULL DEFAULT 0,
  tavily_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_judge_sessions_workspace ON judge_sessions(workspace_id);

CREATE TABLE tenders (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ted','etenders','fts','upload')),
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  buyer TEXT NOT NULL,
  buyer_key TEXT NOT NULL,
  country TEXT NOT NULL,
  cpv_json TEXT NOT NULL DEFAULT '[]',
  value_eur INTEGER,
  deadline TEXT,
  url TEXT,
  lots_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT,
  raw_json TEXT,
  UNIQUE (source, source_ref)
);
CREATE INDEX idx_tenders_deadline ON tenders(deadline);
CREATE INDEX idx_tenders_buyer_key ON tenders(buyer_key);
CREATE INDEX idx_tenders_country ON tenders(country);

CREATE TABLE tender_matches (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tender_id TEXT NOT NULL REFERENCES tenders(id),
  fit_score REAL NOT NULL,
  fit_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','shortlisted','dismissed','bidding')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, tender_id)
);
CREATE INDEX idx_tender_matches_tender ON tender_matches(tender_id);
CREATE INDEX idx_tender_matches_ws_score ON tender_matches(workspace_id, fit_score DESC);

CREATE TABLE intakes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  door TEXT NOT NULL CHECK (door IN ('tender','rfp','design')),
  source TEXT NOT NULL CHECK (source IN ('scan','upload','gmail','outlook','api','chat','mcp')),
  title TEXT NOT NULL,
  sender TEXT,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','classified','processing','ready','ignored')),
  classification_json TEXT,
  tender_id TEXT REFERENCES tenders(id),
  design_request_id TEXT
);
CREATE INDEX idx_intakes_workspace ON intakes(workspace_id, received_at DESC);
CREATE INDEX idx_intakes_tender ON intakes(tender_id);
CREATE INDEX idx_intakes_design ON intakes(design_request_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  tender_id TEXT REFERENCES tenders(id),
  intake_id TEXT REFERENCES intakes(id),
  workspace_id TEXT REFERENCES workspaces(id),
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf','docx','xlsx','image','zip','email')),
  r2_key TEXT NOT NULL,
  pages INTEGER,
  text_r2_key TEXT,
  is_form INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_documents_tender ON documents(tender_id);
CREATE INDEX idx_documents_intake ON documents(intake_id);
CREATE INDEX idx_documents_workspace ON documents(workspace_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  replay INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_runs_workspace ON runs(workspace_id, started_at DESC);
CREATE INDEX idx_runs_subject ON runs(subject_type, subject_id);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('running','ok','error')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  summary TEXT
);
CREATE INDEX idx_run_steps_run ON run_steps(run_id, seq);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tender_id TEXT NOT NULL REFERENCES tenders(id),
  lot TEXT,
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mandatory','scored','info')),
  weight REAL,
  doc_id TEXT REFERENCES documents(id),
  page INTEGER,
  status TEXT NOT NULL DEFAULT 'NEEDS_EVIDENCE' CHECK (status IN ('MET','PARTIAL','GAP','NEEDS_EVIDENCE')),
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  note TEXT
);
CREATE INDEX idx_requirements_ws_tender ON requirements(workspace_id, tender_id);
CREATE INDEX idx_requirements_doc ON requirements(doc_id);

CREATE TABLE verdicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tender_id TEXT NOT NULL REFERENCES tenders(id),
  lot TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('BID','NO_BID','CONDITIONAL')),
  score REAL NOT NULL,
  gates_json TEXT NOT NULL DEFAULT '[]',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT REFERENCES runs(id)
);
CREATE INDEX idx_verdicts_ws_tender ON verdicts(workspace_id, tender_id);
CREATE INDEX idx_verdicts_run ON verdicts(run_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  issuer TEXT,
  scope TEXT,
  valid_to TEXT,
  r2_key TEXT,
  text TEXT,
  meta_json TEXT
);
CREATE INDEX idx_evidence_workspace ON evidence(workspace_id);
CREATE INDEX idx_evidence_valid_to ON evidence(valid_to);

CREATE TABLE evidence_chunks (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding_json TEXT
);
CREATE INDEX idx_evidence_chunks_evidence ON evidence_chunks(evidence_id, seq);
CREATE INDEX idx_evidence_chunks_workspace ON evidence_chunks(workspace_id);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tender_id TEXT NOT NULL REFERENCES tenders(id),
  lot TEXT,
  question_ref TEXT NOT NULL,
  question TEXT NOT NULL,
  word_limit INTEGER,
  draft TEXT NOT NULL DEFAULT '',
  claims_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  approved_at TEXT
);
CREATE INDEX idx_answers_ws_tender ON answers(workspace_id, tender_id);

CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_audits_subject ON audits(workspace_id, subject_type, subject_id);

CREATE TABLE buyer_intel (
  buyer_key TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  family TEXT,
  specs_json TEXT NOT NULL DEFAULT '{}',
  datasheet_doc_id TEXT REFERENCES documents(id),
  unit_price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  UNIQUE (workspace_id, sku)
);
CREATE INDEX idx_products_workspace ON products(workspace_id);

CREATE TABLE price_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  rule_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_price_rules_workspace ON price_rules(workspace_id);

CREATE TABLE design_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  intake_id TEXT REFERENCES intakes(id),
  customer TEXT NOT NULL,
  subject TEXT NOT NULL,
  spec_text TEXT NOT NULL DEFAULT '',
  requirements_json TEXT NOT NULL DEFAULT '[]',
  matches_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX idx_design_requests_workspace ON design_requests(workspace_id);
CREATE INDEX idx_design_requests_intake ON design_requests(intake_id);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  design_request_id TEXT REFERENCES design_requests(id),
  tender_id TEXT REFERENCES tenders(id),
  currency TEXT NOT NULL DEFAULT 'EUR',
  lines_json TEXT NOT NULL DEFAULT '[]',
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
);
CREATE INDEX idx_quotes_workspace ON quotes(workspace_id);
CREATE INDEX idx_quotes_design ON quotes(design_request_id);
CREATE INDEX idx_quotes_tender ON quotes(tender_id);

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','pending','connected','error')),
  external_account_id TEXT,
  meta_json TEXT,
  connected_at TEXT,
  UNIQUE (workspace_id, provider)
);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_webhook_endpoints_workspace ON webhook_endpoints(workspace_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, at DESC);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX idx_events_workspace_at ON events(workspace_id, at DESC);

-- agent_threads / agent_messages live in the AgentHub Durable Object (SQLite), not here.

CREATE TABLE subscriptions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  plan TEXT NOT NULL DEFAULT 'free',
  dodo_customer_id TEXT,
  dodo_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  current_period_end TEXT
);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  external_event_id TEXT UNIQUE,
  at TEXT NOT NULL
);
CREATE INDEX idx_credit_ledger_workspace ON credit_ledger(workspace_id, at DESC);
CREATE UNIQUE INDEX idx_credit_ledger_ref ON credit_ledger(workspace_id, ref) WHERE ref IS NOT NULL;

CREATE TABLE limits_counters (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
