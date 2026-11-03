-- Widen tenders.source for UK Contracts Finder ('cf') and World Bank ('wb') notices saved from onboarding.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt with identical columns, keys and indexes.
-- Child tables reference tenders(id) by name; deferring FK checks keeps them valid across the rename.
PRAGMA defer_foreign_keys = true;
CREATE TABLE tenders_v85 (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ted','etenders','fts','upload','cf','wb')),
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
INSERT INTO tenders_v85 (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, value_eur, deadline, url, lots_json, published_at, raw_json)
  SELECT id, source, source_ref, title, buyer, buyer_key, country, cpv_json, value_eur, deadline, url, lots_json, published_at, raw_json FROM tenders;
DROP TABLE tenders;
ALTER TABLE tenders_v85 RENAME TO tenders;
CREATE INDEX idx_tenders_deadline ON tenders(deadline);
CREATE INDEX idx_tenders_buyer_key ON tenders(buyer_key);
CREATE INDEX idx_tenders_country ON tenders(country);
PRAGMA defer_foreign_keys = false;
