-- Internal commercial data deliberately lives outside product specs and quote/model inputs.
CREATE TABLE product_costs (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  internal_unit_cost_minor INTEGER NOT NULL CHECK(internal_unit_cost_minor >= 0 AND internal_unit_cost_minor <= 1000000000000),
  cost_currency TEXT NOT NULL,
  cost_unit TEXT NOT NULL,
  zero_cost_confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX product_costs_workspace ON product_costs(workspace_id);
-- Private cost edits participate in the same optimistic manual-edit conflict protocol.
CREATE TRIGGER integration_cost_update AFTER UPDATE ON product_costs BEGIN UPDATE integration_product_versions SET revision=revision+1 WHERE product_id=NEW.product_id; END;
CREATE TABLE integration_normalizations (
  job_id TEXT NOT NULL REFERENCES integration_jobs(id),
  revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id,revision)
);
