import { fromRow, HttpError, newId, ProductInput, type Product } from '@pactovio/contracts';
export { ProductInput };
const privateSelect = `SELECT p.*,json_extract(p.specs_json,'$.description') AS description,
  c.internal_unit_cost_minor,c.cost_currency,c.cost_unit,c.zero_cost_confirmed
  FROM products p LEFT JOIN product_costs c ON c.product_id=p.id AND c.workspace_id=p.workspace_id`;
/** Only authenticated catalogue routes use this join; quote/model loaders never read product_costs. */
export async function listProducts(db: D1Database, workspaceId: string) {
  const result = await db.prepare(`${privateSelect} WHERE p.workspace_id=? ORDER BY p.family,p.sku`).bind(workspaceId).all();
  return result.results.map(r => fromRow<Product>(r));
}
async function readProduct(db: D1Database, workspaceId: string, id: string): Promise<Product> {
  const row = await db.prepare(`${privateSelect} WHERE p.id=? AND p.workspace_id=?`).bind(id, workspaceId).first();
  if (!row) throw new HttpError(404, 'Product not found', 'not_found');
  return fromRow<Product>(row);
}
/** Confirmed source/manual values only. Quote lines remain immutable selling-price snapshots. */
export async function saveProduct(db: D1Database, workspaceId: string, input: unknown, id?: string): Promise<Product> {
  const data = ProductInput.parse(input);
  if (data.unit_price_minor === 0 && !data.zero_price_confirmed || data.internal_unit_cost_minor === 0 && !data.zero_cost_confirmed) {
    throw new HttpError(400, 'Explicitly confirm each zero amount before saving.', 'zero_confirmation_required');
  }
  const ws = await db.prepare('SELECT id FROM workspaces WHERE id=? AND sample=0').bind(workspaceId).first();
  if (!ws) throw new HttpError(403, 'A private customer workspace is required', 'forbidden');
  const existing = id ? await readProduct(db, workspaceId, id) : null;
  const productId = id ?? newId('product');
  const sku = data.sku ?? ((existing?.specs as Record<string, unknown> | null)?.sku_origin === 'internal_reference'
    ? existing!.sku : `PVI-${productId}`.slice(0,64).toUpperCase());
  const duplicate = await db.prepare('SELECT id FROM products WHERE workspace_id=? AND UPPER(sku)=? AND id!=?')
    .bind(workspaceId, sku, id ?? '').first();
  if (duplicate) throw new HttpError(409, 'This catalogue reference already exists', 'duplicate_sku');
  const specs = JSON.stringify({ unit: data.unit, description: data.description, zero_price_confirmed: !!data.zero_price_confirmed,
    sku_origin: data.sku ? 'manufacturer' : 'internal_reference', price_basis: 'Customer-provided catalogue price' });
  try {
    await db.batch([
      id ? db.prepare(`UPDATE products SET sku=?,name=?,family=?,specs_json=json_patch(specs_json,?),unit_price_minor=?,currency=? WHERE id=? AND workspace_id=?`)
        .bind(sku, data.name, data.family || null, specs, data.unit_price_minor, data.currency, id, workspaceId)
        : db.prepare(`INSERT INTO products(id,workspace_id,sku,name,family,specs_json,unit_price_minor,currency) VALUES(?,?,?,?,?,?,?,?)`)
          .bind(productId, workspaceId, sku, data.name, data.family || null, specs, data.unit_price_minor, data.currency),
      db.prepare(`INSERT INTO product_costs(product_id,workspace_id,internal_unit_cost_minor,cost_currency,cost_unit,zero_cost_confirmed,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET internal_unit_cost_minor=excluded.internal_unit_cost_minor,
        cost_currency=excluded.cost_currency,cost_unit=excluded.cost_unit,zero_cost_confirmed=excluded.zero_cost_confirmed,updated_at=excluded.updated_at`)
        .bind(productId, workspaceId, data.internal_unit_cost_minor, data.cost_currency, data.cost_unit, data.zero_cost_confirmed ? 1 : 0, new Date().toISOString()),
    ]);
  } catch {
    const conflict = await db.prepare('SELECT id FROM products WHERE workspace_id=? AND sku=? AND id!=?').bind(workspaceId, sku, productId).first();
    if (conflict) throw new HttpError(409, 'This catalogue reference already exists', 'duplicate_sku');
    throw new HttpError(500, 'Your product could not be saved. Try again.', 'storage_unavailable');
  }
  return readProduct(db, workspaceId, productId);
}
