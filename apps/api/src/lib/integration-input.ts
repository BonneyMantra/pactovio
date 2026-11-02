import { z } from 'zod';
import { ProductInput, HttpError, PRODUCT_CURRENCIES } from '@pactovio/contracts';
export const Slug = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,159}$/);
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const Scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
export const RecordInput = z.record(z.string().min(1).max(160), Scalar).refine(x => Object.keys(x).length <= 100);
const field = z.string().min(1).max(160);
export const FieldMap = z.object({
  external_id: field, name: field, sku: field.optional(), description: field.optional(),
  price: field, currency: field.optional(), confirmed_currency: ProductInput.shape.currency.optional(), unit: field.optional(),
  price_format: z.enum(['decimal', 'minor']), cost: field.optional(), cost_currency: field.optional(),
  confirmed_cost_currency: ProductInput.shape.cost_currency.optional(), cost_unit: field.optional(),
  cost_format: z.enum(['decimal', 'minor']).optional(),
}).strict().refine(x => !(x.currency && x.confirmed_currency) && !(x.cost_currency && x.confirmed_cost_currency), 'Choose a currency column or confirmed constant, not both');
export const PreviewInput = z.object({ revision: z.number().int().nonnegative(), mapping: FieldMap,
  resolutions: z.array(z.object({ external_id: z.string().min(1).max(200), product: ProductInput.partial() }).strict()).max(100).default([]),
  selected_ids: z.array(z.string().min(1).max(200)).min(1).max(100).refine(a => new Set(a).size === a.length),
}).strict();
export const ApproveInput = z.object({ revision: z.number().int().nonnegative(), preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
}).strict();
export const RevisionInput = z.object({ revision: z.number().int().nonnegative() }).strict();
export const TableInput = z.object({ resource: z.string().trim().min(1).max(200),
  rows: z.array(RecordInput).min(1).max(100), external_id_field: field,
}).strict();
export function conflict(): never { throw new HttpError(409, 'This import changed. Refresh the preview before continuing.', 'preview_conflict'); }
export function unavailable(): never { throw new HttpError(503, 'The integration is unavailable. Try again.', 'integration_unavailable'); }
export const sensitive = /password|secret|token|credential|authorization|api.?key|cookie/i;
/** Exact decimal/grouping validation; unknown, negative and malformed money never becomes zero. */
export function priceMinor(value: unknown, format: 'decimal' | 'minor'): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let text = String(value).trim();
  if (format === 'minor') return /^\d{1,13}$/.test(text) && Number(text) <= 1e12 ? Number(text) : null;
  if (text.includes(',')) {
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?$/.test(text)) return null;
    text = text.replaceAll(',', '');
  }
  if (!/^\d{1,11}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents <= 1000000000000n ? Number(cents) : null;
}
export function mapProduct(record: Record<string, unknown>, mapping: z.infer<typeof FieldMap>, resolution: Partial<z.infer<typeof ProductInput>> = {}) {
  const read = (key?: string) => key ? record[key] : undefined;
  const raw = { name: read(mapping.name), sku: typeof read(mapping.sku)==='string' && !String(read(mapping.sku)).trim() ? undefined : read(mapping.sku), description: read(mapping.description),
    unit_price_minor: priceMinor(read(mapping.price), mapping.price_format), currency: mapping.confirmed_currency ?? read(mapping.currency), unit: read(mapping.unit),
    internal_unit_cost_minor: priceMinor(read(mapping.cost), mapping.cost_format ?? 'decimal'),
    cost_currency: mapping.confirmed_cost_currency ?? read(mapping.cost_currency), cost_unit: read(mapping.cost_unit), ...resolution };
  const candidate: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(ProductInput.shape)) {
    const value = schema.safeParse(raw[key as keyof typeof raw]);
    if (value.success && value.data !== undefined) candidate[key] = value.data;
  }
  const parsed = ProductInput.safeParse(raw);
  const unresolved = parsed.success ? [] : [...new Set(parsed.error.issues.map(x => String(x.path[0])))];
  for (const [column,currency,key,issue] of [[mapping.price,raw.currency,'currency','currency_conflict'],[mapping.cost,raw.cost_currency,'cost_currency','cost_currency_conflict']] as const) {
    const explicit=PRODUCT_CURRENCIES.filter(iso=>column && new RegExp(`(?:^|[^A-Z])${iso}(?:$|[^A-Z])`,'i').test(column));
    if (explicit.length && currency!=null && !explicit.includes(String(currency).trim().toUpperCase() as typeof PRODUCT_CURRENCIES[number]) && !Object.hasOwn(resolution,key)) unresolved.push(issue);
  }
  if (raw.unit_price_minor === 0 && !resolution.zero_price_confirmed) unresolved.push('zero_price_confirmed');
  if (raw.internal_unit_cost_minor === 0 && !resolution.zero_cost_confirmed) unresolved.push('zero_cost_confirmed');
  return { product: parsed.success ? parsed.data : null, candidate, unresolved };
}
