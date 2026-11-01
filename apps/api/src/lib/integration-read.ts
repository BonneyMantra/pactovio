import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { HttpError } from '@pactovio/contracts';
import { type Adapter, pins, bindingIssue, schemaShape, readArguments, flattenRecord, malformed } from './integration-bindings';
import { canonical, matchesSchema } from './integration-schema';
import { integrationClient } from './integration-provider';
import { unavailable } from './integration-input';
import { workspaceUser, type Connection, verifiedAccount } from './integration-connections';
const Tool = z.object({ slug: z.string(), version: z.string(), toolkit: z.object({ slug: z.string() }),
  input_parameters: z.record(z.string(), z.unknown()), output_parameters: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()), scopes: z.array(z.string()).nullish(), is_deprecated: z.boolean().default(false),
});
export async function boundTool(env: Env, adapter: Adapter) {
  const pin = pins[adapter];
  try {
    const tool = Tool.parse(await integrationClient(env).request('GET', `/tools/${pin.slug}`, undefined, { version: pin.version }));
    if (tool.slug !== pin.slug || tool.toolkit.slug !== adapter || tool.version !== pin.version || tool.is_deprecated
      || canonical(schemaShape(tool.input_parameters)) !== canonical(pin.input)
      || canonical(schemaShape(tool.output_parameters)) !== canonical(pin.output)
      || canonical([...tool.tags].sort()) !== canonical([...pin.tags].sort())
      || canonical([...(tool.scopes ?? [])].sort()) !== canonical([...(pin.scopes ?? [])].sort())) {
      throw new HttpError(409, 'The source operation changed and needs compatibility verification.', 'adapter_changed');
    }
    return tool;
  } catch (e) { if (e instanceof HttpError) throw e; unavailable(); }
}
const array = (v: unknown): any[] => Array.isArray(v) && v.length <= 500 ? v : malformed();
const sourceId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200 ? v
  : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : malformed();
const cursorValue = (v: unknown): string | number | null => v == null || v === '' ? null
  : typeof v === 'string' && v.length <= 4096 || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : malformed();
export interface SourceRow { external_id: string; source_version: string | null; record: Record<string, string | number | boolean | null> }
export function decodePage(adapter: Adapter, data: any, cursor: unknown): { rows: SourceRow[]; next: string | number | null; exhausted: boolean } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) malformed();
  if (data.errors?.length || data.numErrors > 0 || data.success === false || data.code !== undefined && data.code !== 0) {
    throw new HttpError(502, 'Some selected source records could not be read. Retry or narrow the selection.', 'source_partial');
  }
  let records: any[] = [], next: string | number | null = null;
  switch (adapter) {
    case 'zoho_inventory': case 'zoho_books':
      records = array(data.items); next = data.page_context?.has_more_page === false || records.length < 50 ? null : Number(cursor ?? 1) + 1; break;
    case 'shopify': records = array(data.products); next = cursorValue(data.next_page_info); break;
    case 'square': records = array(data.objects ?? []); next = cursorValue(data.cursor); break;
    case 'stripe': records = array(data.data); next = data.has_more === true ? sourceId(records.at(-1)?.id) : null; break;
    case 'quickbooks': records = array(data.QueryResponse?.Item ?? []); next = records.length === 50 ? Number(cursor ?? 1) + 50 : null; break;
    case 'xero': records = array(data.Items); break;
    case 'hubspot': records = array(data.results); if (data.status !== 'COMPLETE') malformed(); break;
    case 'salesforce': records = array(data.records); next = records.length === 50 ? Number(cursor ?? 0) + 50 : null; break;
    case 'pipedrive': records = array(data.data); next = data.additional_data?.pagination?.more_items_in_collection ? cursorValue(data.additional_data.pagination.next_start) : null; break;
    case 'googlesheets': case 'googledrive': records = array(data.values ?? []); break;
    case 'excel': records = array(data.rows); next = data.odata_next_link ? Number(cursor ?? 0) + 50 : null; break;
    case 'airtable': records = array(data.records); next = cursorValue(data.offset); break;
    case 'notion': records = array(data.results); next = data.has_more ? cursorValue(data.next_cursor) : null; if (data.has_more && !next) malformed(); break;
    case 'netsuite': records = array(data.items); next = data.hasMore ? Number(cursor ?? 0) + 50 : null; break;
    case 'share_point': records = array(data.items); next = cursorValue(data.skiptoken); break;
    case 'erpnext': records = [data.message]; break;
  }
  if (next !== null && (next === cursor || records.length === 0)) malformed();
  const rows: SourceRow[] = [];
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object') malformed();
    const append = (value: unknown, id: unknown, version: unknown = null) => {
      const external_id = sourceId(id), source_version = version == null ? null : sourceId(version);
      rows.push({ external_id, source_version, record: { ...flattenRecord(value), _source_id: external_id } });
    };
    if (adapter === 'googlesheets' || adapter === 'googledrive') {
      if (!Array.isArray(record) || record.length > 50) malformed();
      append(Object.fromEntries(record.map((value: unknown, col: number) => [`column_${col + 1}`, value])), `row_${index + 1}`);
    } else if (adapter === 'excel') {
      if (!Array.isArray(record.values) || record.values.length !== 1 || !Array.isArray(record.values[0])) malformed();
      append(Object.fromEntries(record.values[0].map((value: unknown, col: number) => [`column_${col + 1}`, value])), `row_${sourceId(record.index)}`);
    } else if (adapter === 'shopify') {
      for (const variant of array(record.variants ?? [])) append({ ...variant, product_name: record.title }, variant.id, variant.updated_at ?? record.updated_at);
    } else if (adapter === 'square') {
      if (record.type !== 'ITEM') malformed();
      for (const variation of array(record.item_data?.variations ?? [])) append({ ...variation, product_name: record.item_data.name }, variation.id, variation.version ?? record.version);
    } else {
      const ids: Partial<Record<Adapter, string>> = { zoho_inventory: 'item_id', zoho_books: 'item_id', xero: 'ItemID',
        salesforce: 'Id', quickbooks: 'Id', share_point: 'Id', erpnext: 'item_code' };
      append(record, record[ids[adapter] ?? 'id'], record.updated_at ?? record.updatedAt ?? record.SystemModstamp ?? record.update_time ?? record.Modified ?? record.MetaData?.LastUpdatedTime ?? record.last_modified_time ?? record.last_edited_time ?? record.updated ?? record.SyncToken ?? record.__metadata?.etag);
    }
  }
  if (rows.length > 100 || new Set(rows.map(r => r.external_id)).size !== rows.length) malformed();
  return { rows, next, exhausted: next === null };
}
export async function readSelected(env: Env, connection: Connection, adapter: Adapter, resource: unknown, cursor: unknown) {
  if (bindingIssue(adapter)) throw new HttpError(409, 'The upstream input schema needs compatibility verification before this read is available.', 'adapter_changed');
  if (connection.toolkit !== adapter) throw new HttpError(400, 'The selected source does not match this connection.', 'validation');
  const account = await verifiedAccount(env, connection), tool = await boundTool(env, adapter);
  const args = readArguments(adapter, resource, cursor);
  if (!matchesSchema(args, pins[adapter].input)) malformed();
  // The exact non-destructive binding above is authority; readOnlyHint alone never is.
  let response: Record<string, unknown>;
  try { response = await integrationClient(env).request('POST', `/tools/execute/${tool.slug}`, {
    connected_account_id: account.id, user_id: workspaceUser(connection.workspace_id), version: tool.version, arguments: args,
  }); } catch { unavailable(); }
  if (response.successful !== true) throw new HttpError(502, 'The selected source read failed. Retry to continue.', 'source_read_failed');
  const safe = { data: response.data, successful: true, ...(typeof response.error === 'string' ? { error: response.error } : {}) };
  if (!matchesSchema(safe, pins[adapter].output)) malformed();
  return decodePage(adapter, response.data, cursor);
}
