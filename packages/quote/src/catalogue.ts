import { z } from 'zod';
import { fromRow, HttpError, newId, type Product } from '@pactovio/contracts';

export const ProductInput = z.object({
  sku: z.string().trim().min(1).max(64).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(160),
  family: z.string().trim().max(100).nullable().optional(),
  unit: z.string().trim().min(1).max(40).default('each'),
  unit_price_minor: z.number().int().nonnegative().max(1_000_000_000_000),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase()),
}).strict();

async function requireCustomer(db: D1Database, workspaceId: string): Promise<void> {
  const ws = await db.prepare('SELECT id FROM workspaces WHERE id = ? AND sample = 0').bind(workspaceId).first();
  if (!ws) throw new HttpError(403, 'A private customer workspace is required', 'forbidden');
}

async function readProduct(db: D1Database, workspaceId: string, id: string): Promise<Product> {
  const row = await db.prepare('SELECT * FROM products WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).first();
  if (!row) throw new HttpError(404, 'Product not found', 'not_found');
  return fromRow<Product>(row);
}

/** Customer-supplied prices only. Existing quote lines remain immutable snapshots. */
export async function saveProduct(db: D1Database, workspaceId: string, input: unknown, id?: string): Promise<Product> {
  const data = ProductInput.parse(input);
  await requireCustomer(db, workspaceId);
  if (id) await readProduct(db, workspaceId, id);
  const duplicate = await db.prepare('SELECT id FROM products WHERE workspace_id = ? AND UPPER(sku) = ? AND id != ?')
    .bind(workspaceId, data.sku, id ?? '').first();
  if (duplicate) throw new HttpError(409, 'This SKU already exists in your catalogue', 'duplicate_sku');
  const productId = id ?? newId('product');
  const specs = JSON.stringify({ unit: data.unit, price_basis: 'Customer-provided catalogue price' });
  try {
    if (id) {
      await db.prepare(`UPDATE products SET sku = ?, name = ?, family = ?, specs_json = json_patch(specs_json, ?),
        unit_price_minor = ?, currency = ? WHERE id = ? AND workspace_id = ?`)
        .bind(data.sku, data.name, data.family || null, specs, data.unit_price_minor, data.currency, id, workspaceId).run();
    } else {
      await db.prepare(`INSERT INTO products (id, workspace_id, sku, name, family, specs_json, unit_price_minor, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(productId, workspaceId, data.sku, data.name, data.family || null, specs, data.unit_price_minor, data.currency).run();
    }
  } catch {
    // A concurrent insert can win the unique SKU constraint after our read.
    const conflict = await db.prepare('SELECT id FROM products WHERE workspace_id = ? AND sku = ? AND id != ?')
      .bind(workspaceId, data.sku, productId).first();
    if (conflict) throw new HttpError(409, 'This SKU already exists in your catalogue', 'duplicate_sku');
    throw new HttpError(500, 'Your product could not be saved. Try again.', 'storage_unavailable');
  }
  return readProduct(db, workspaceId, productId);
}
