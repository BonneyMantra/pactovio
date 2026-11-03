-- Onboarding v3: product images. Additive columns; the image bytes live in R2 (FILES) under products/<workspace>/<product>/.
ALTER TABLE products ADD COLUMN image_key TEXT;
ALTER TABLE products ADD COLUMN image_source_url TEXT;
ALTER TABLE products ADD COLUMN image_updated_at TEXT;
-- An image is not a catalogue edit: the revision trigger now fires only for catalogue columns, so setting an image never
-- turns the next source import of that product into a manual-edit conflict. Same body as 0081, narrower column list.
DROP TRIGGER IF EXISTS integration_product_update;
CREATE TRIGGER integration_product_update AFTER UPDATE OF workspace_id, sku, name, family, specs_json, datasheet_doc_id, unit_price_minor, currency ON products BEGIN INSERT INTO integration_product_versions(product_id, revision) VALUES(NEW.id, 1) ON CONFLICT(product_id) DO UPDATE SET revision = revision + 1; END;
-- Saved tenders write their stated key dates as deadlines; the row keeps which tender (and which kind of date) it came from.
ALTER TABLE workspace_deadlines ADD COLUMN tender_id TEXT;
ALTER TABLE workspace_deadlines ADD COLUMN kind TEXT;
CREATE INDEX workspace_deadlines_tender ON workspace_deadlines(workspace_id, tender_id);
