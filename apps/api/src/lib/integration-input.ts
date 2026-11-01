import { z } from 'zod';
import { ProductInput, HttpError } from '@pactovio/contracts';
export const Slug = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,159}$/);
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const Scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
export const RecordInput = z.record(z.string().min(1).max(160), Scalar).refine(x => Object.keys(x).length <= 100);
export const FieldMap = z.object({
  external_id: z.string().min(1).max(160), name: z.string().min(1).max(160), sku: z.string().min(1).max(160),
  price: z.string().min(1).max(160), currency: z.string().min(1).max(160).optional(),
  confirmed_currency: ProductInput.shape.currency.optional(), unit: z.string().min(1).max(160).optional(),
  price_format: z.enum(['decimal', 'minor']),
}).strict().refine(x => !!x.currency !== !!x.confirmed_currency, 'Choose a currency field or explicitly confirm a currency');
export const PreviewInput = z.object({ revision: z.number().int().nonnegative(), mapping: FieldMap,
  resolutions: z.array(z.object({ external_id: z.string().min(1).max(200), product: ProductInput.partial() }).strict()).max(100).default([]),
  selected_ids: z.array(z.string().min(1).max(200)).min(1).max(100).refine(a => new Set(a).size === a.length),
}).strict();
export const ApproveInput = z.object({ revision: z.number().int().nonnegative(), preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
}).strict();
export const RevisionInput = z.object({ revision: z.number().int().nonnegative() }).strict();
export const TableInput = z.object({ resource: z.string().trim().min(1).max(200),
  rows: z.array(RecordInput).min(1).max(100), external_id_field: z.string().min(1).max(160),
}).strict();
export function conflict(): never { throw new HttpError(409, 'This import changed. Refresh the preview before continuing.', 'preview_conflict'); }
export function unavailable(): never { throw new HttpError(503, 'The integration is unavailable. Try again.', 'integration_unavailable'); }
export const sensitive = /password|secret|token|credential|authorization|api.?key|cookie/i;
/** Exact integer arithmetic; never multiply a binary floating point price by 100. */
export function priceMinor(value: unknown, format: 'decimal' | 'minor'): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (format === 'minor') return /^\d{1,13}$/.test(text) && Number(text) <= 1e12 ? Number(text) : null;
  if (!/^\d{1,11}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= 1000000000000n ? Number(cents) : null;
}
export function mapProduct(record: Record<string, unknown>, mapping: z.infer<typeof FieldMap>, resolution: Partial<z.infer<typeof ProductInput>> = {}) {
  const price = priceMinor(record[mapping.price], mapping.price_format);
  const result = ProductInput.safeParse({ name: record[mapping.name], sku: record[mapping.sku],
    unit_price_minor: price, currency: mapping.confirmed_currency ?? record[mapping.currency!],
    ...(mapping.unit ? { unit: record[mapping.unit] } : {}), ...resolution,
  });
  return result.success ? { product: result.data, unresolved: [] as string[] } : {
    product: null, unresolved: [...new Set(result.error.issues.map(x => String(x.path[0])))],
  };
}
