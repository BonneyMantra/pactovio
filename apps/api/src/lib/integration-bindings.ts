import { z } from 'zod';
import reviewed from '../../../../packages/integrations/src/reviewed-tools.json';
import { ProductInput, HttpError } from '@pactovio/contracts';
import { sensitive } from './integration-input';
const ref = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f]+$/);
const scope = z.literal('selected_catalogue');
const a1 = z.string().max(200).regex(/^'?[^'!]{1,80}'?![A-Z]{1,2}[1-9]\d{0,6}:[A-Z]{1,2}[1-9]\d{0,6}$/).refine(v => {
  const m = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(v);
  if (!m) return false;
  const col = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return +m[4] >= +m[2] && +m[4] - +m[2] < 100 && col(m[3]) >= col(m[1]) && col(m[3]) - col(m[1]) < 50;
});
const selected = (fields: z.ZodRawShape) => z.object(fields).strict();
export const selections = {
  zoho_inventory: selected({ organization_id: ref }), zoho_books: selected({ organization_id: ref }),
  shopify: selected({ scope }), square: selected({ scope }), stripe: selected({ scope }),
  quickbooks: selected({ scope }), xero: selected({ tenant_id: ref }),
  hubspot: selected({ scope }),
  salesforce: selected({ pricebook_id: z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/) }),
  pipedrive: selected({ scope }),
  googlesheets: selected({ spreadsheet_id: ref, range: a1 }), googledrive: selected({ spreadsheet_id: ref, range: a1 }),
  excel: selected({ drive_id: ref, item_id: ref, table_id: ref }),
  airtable: selected({ baseId: z.string().regex(/^app[A-Za-z0-9]{14}$/), tableIdOrName: ref }),
  notion: selected({ database_id: z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i) }),
  netsuite: selected({ scope }), share_point: selected({ site_name: ref, list_title: ref }),
  erpnext: selected({ item_code: ref, company: ref, price_list: ref, currency: ProductInput.shape.currency, conversion_rate: z.number().positive().max(1000000) }),
};
export type Adapter = keyof typeof selections;
export const adapters = Object.keys(selections) as Adapter[];
export const pins = reviewed;
// The actual 20261030_00 schema has a double-escaped organization_id regex; do not silently repair upstream contracts.
export const bindingIssue = (adapter: string) => adapter === 'zoho_books' ? 'upstream_input_schema_incompatible' : null;
export const isAdapter = (value: string): value is Adapter => Object.hasOwn(selections, value);
/** All query text and limits are server authored. Clients select resources, never tool slugs or raw arguments. */
export function readArguments(adapter: Adapter, resource: unknown, cursor: unknown): Record<string, unknown> {
  const r = selections[adapter].parse(resource) as Record<string, any>;
  const c = cursor == null ? null : z.union([z.string().min(1).max(4096), z.number().int().min(0).max(10000)]).parse(cursor);
  switch (adapter) {
    case 'zoho_inventory': case 'zoho_books': return { ...r, page: c ?? 1, per_page: 50 };
    case 'shopify': return { limit: 50, ...(c ? { page_info: c } : {}) };
    case 'square': return { object_types: ['ITEM'], include_deleted_objects: false, limit: 50, ...(c ? { cursor: c } : {}) };
    case 'stripe': return { active: true, limit: 50, ...(c ? { starting_after: c } : {}) };
    case 'quickbooks': return { query: `SELECT * FROM Item ORDERBY Id STARTPOSITION ${c ?? 1} MAXRESULTS 50` };
    case 'xero': return { tenant_id: r.tenant_id };
    case 'hubspot': return { limit: 50, properties: ['name', 'hs_sku', 'price'], archived: false, ...(c ? { after: String(c) } : {}) };
    case 'salesforce': return { query: `SELECT Id,Product2.Name,Product2.ProductCode,UnitPrice,CurrencyIsoCode,SystemModstamp FROM PricebookEntry WHERE Pricebook2Id = '${r.pricebook_id}' AND IsActive = true ORDER BY Id LIMIT 50 OFFSET ${c ?? 0}` };
    case 'pipedrive': return { limit: 50, start: c ?? 0 };
    case 'googlesheets': case 'googledrive': return { ...r, major_dimension: 'ROWS', value_render_option: 'UNFORMATTED_VALUE' };
    case 'excel': return { ...r, top: 50, skip: c ?? 0 };
    case 'airtable': return { ...r, pageSize: 50, ...(c ? { offset: c } : {}) };
    case 'notion': return { ...r, page_size: 50, ...(c ? { start_cursor: c } : {}) };
    case 'netsuite': return { q: "SELECT id,itemid,displayname FROM item WHERE isinactive = 'F' ORDER BY id", limit: 50, offset: c ?? 0 };
    case 'share_point': return { ...r, top: 50, ...(c ? { skiptoken: c } : {}) };
    case 'erpnext': return { ctx: { ...r, doctype: 'Quotation', qty: 1 } };
  }
}
/** Strip annotation text and examples; only structural schema assertions participate in version binding. */
export function schemaShape(value: any): any {
  if (Array.isArray(value)) return value.map(schemaShape);
  if (!value || typeof value !== 'object') return value;
  const keys = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', '$ref', '$defs', 'anyOf', 'oneOf', 'allOf',
    'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'not', 'if', 'patternProperties', 'unevaluatedProperties', 'format', 'minProperties', 'maxProperties',
    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'uniqueItems', 'additionalItems', 'prefixItems', 'dependentRequired',
    'dependentSchemas', 'contains', 'minContains', 'maxContains', 'propertyNames', 'unevaluatedItems']);
  return Object.fromEntries(Object.entries(value).filter(([k]) => keys.has(k)).map(([k, v]) => [k,
    ['properties', '$defs', 'patternProperties'].includes(k) ? Object.fromEntries(Object.entries(v as object).map(([n, s]) => [n, schemaShape(s)])) : schemaShape(v)]));
}
export function flattenRecord(value: unknown, prefix = '', output: Record<string, string | number | boolean | null> = {}, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return output;
  for (const [key, val] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (sensitive.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || path.length > 160 || Object.keys(output).length >= 100) continue;
    if (val === null || typeof val === 'string' && val.length <= 4096 || typeof val === 'number' && Number.isFinite(val) || typeof val === 'boolean') output[path] = val;
    else if (val && typeof val === 'object') flattenRecord(val, path, output, depth + 1);
  }
  return output;
}
export const malformed = (): never => { throw new HttpError(502, 'The source returned data that could not be safely imported.', 'source_malformed'); };
