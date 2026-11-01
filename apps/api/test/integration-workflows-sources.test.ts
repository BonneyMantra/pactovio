import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, providerTransport, resources, tool } from '../../../packages/integrations/test/fixture';
import { adapters, bindingIssue, pins, type Adapter } from '../src/lib/integration-bindings';
import { matchesSchema } from '../src/lib/integration-schema';
const time = '2026-11-01T08:00:00.000Z';
/** Provider HTTP fixtures, checked against recorded project schemas. They are not live source reads. */
const samples: Partial<Record<Adapter, any>> = {
  zoho_inventory: { code: 0, message: 'success', items: [{ item_id: 'laser', sku: 'ML-500', name: 'Meridian laser level', rate: 12.34, last_modified_time: time }] },
  shopify: { products: [{ id: 200, title: 'Meridian laser level', variants: [{ id: 201, sku: 'ML-501', price: '12.34', updated_at: time }] }] },
  square: { objects: [{ id: 'square-laser', type: 'ITEM', version: 3, item_data: { name: 'Meridian laser level', variations: [
    { id: 'variation-laser', type: 'ITEM_VARIATION', item_variation_data: { sku: 'ML-502', name: 'Meridian laser level', price_money: { amount: 1234, currency: 'MYR' } } },
  ] } }] },
  stripe: { object: 'list', url: '/v1/products', has_more: false, data: [{ id: 'prod_laser', object: 'product', active: true,
    created: 1793520000, updated: 1793520000, name: 'Meridian laser level', livemode: false, metadata: { sku: 'ML-503' }, default_price: 'price_laser' }] },
  quickbooks: { QueryResponse: { Item: [{ Id: 'laser', Name: 'Meridian laser level', Sku: 'ML-504', UnitPrice: 12.34 }] } },
  xero: { Items: [{ ItemID: 'laser', Code: 'ML-505', Name: 'Meridian laser level', SalesDetails: { UnitPrice: 12.34 } }] },
  hubspot: { completedAt: time, startedAt: time, status: 'COMPLETE', results: [{ id: 'product-laser', archived: false,
    createdAt: time, updatedAt: time, properties: { name: 'Meridian laser level', hs_sku: 'ML-506', price: '12.34' } }] },
  salesforce: { totalSize: 1, done: true, records: [{ attributes: { type: 'PricebookEntry' }, Id: '01u000000000001AAA',
    Product2: { Name: 'Meridian laser level', ProductCode: 'ML-507' }, UnitPrice: 12.34, CurrencyIsoCode: 'MYR', SystemModstamp: time }] },
  pipedrive: { success: true, additional_data: {}, data: [{ id: 301, name: 'Meridian laser level', code: 'ML-508', visible_to: '3',
    owner_id: { id: 10 }, prices: [{ price: 12.34, currency: 'MYR' }] }] },
  googlesheets: { range: "'Inventory'!A1:F50", majorDimension: 'ROWS', values: [['ML-509', 'Meridian laser level', '12.34', 'MYR']] },
  googledrive: { range: 'Inventory!A1:F50', majorDimension: 'ROWS', values: [['ML-510', 'Meridian laser level', '12.34', 'MYR']] },
  excel: { rows: [{ index: 0, values: [['ML-511', 'Meridian laser level', 12.34, 'MYR']] }] },
  airtable: { records: [{ id: 'rec12345678901234', createdTime: time, fields: { SKU: 'ML-512', Name: 'Meridian laser level', Price: 12.34 } }] },
  notion: { object: 'list', has_more: false, results: [{ id: 'page-laser', object: 'page', properties: { Name: { id: 'title', type: 'title', title: [{ type: 'text', plain_text: 'Meridian laser level',
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' }, text: { content: 'Meridian laser level' } }] } }, last_edited_time: time }] },
  netsuite: { links: [], items: [{ links: [], id: 'laser', itemid: 'ML-513', displayname: 'Meridian laser level' }], count: 1, offset: 0, hasMore: false, totalResults: 1 },
  share_point: { items: [{ Id: 1, Title: 'Meridian laser level', __metadata: { id: 'list-laser', uri: '/items/1', etag: '3', type: 'SP.Data.InventoryListItem' } }] },
  erpnext: { message: { item_code: 'ML-100', item_name: 'Meridian laser level', rate: 12.34 } },
};
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => f.dispose());
describe('source schema to persisted import protocol', () => {
  it.each(adapters.filter(a => !bindingIssue(a)))('%s stages only records decoded from its schema-checked source response', async adapter => {
    const connection = await f.createConnection(adapter), pin = tool(adapter), data = samples[adapter];
    expect(matchesSchema({ successful: true, data }, pins[adapter].output)).toBe(true);
    const t = providerTransport((method, path, body) => {
      if (path === `/connected_accounts/${connection.account_id}`) return { id: connection.account_id, toolkit: { slug: adapter }, user_id: connection.user_id, status: 'ACTIVE' };
      if (path === `/tools/${pin.slug}`) return pin;
      if (path === `/tools/execute/${pin.slug}` && method === 'POST') {
        expect(body.connected_account_id).toBe(connection.account_id); expect(body.version).toBe(pin.version);
        return { successful: true, data };
      }
      throw new Error('Unexpected source transport operation');
    });
    const select = await f.call('/imports/select', { connection_id: connection.id, adapter, resource: resources[adapter] });
    expect(select.status).toBe(201); const job = await select.json() as any;
    const read = await f.call(`/imports/${job.id}/read`, { revision: job.revision }); expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ staged: 1, applied: 0, exhausted: true, state: 'staged', revision: 1 });
    const rows = await (await f.call(`/imports/${job.id}/rows`)).json() as any;
    expect(rows.items[0].external_id).toBeTruthy(); expect(rows.items[0].retrieved_at).toBeTruthy();
    expect(rows.items[0].record._source_id).toBe(rows.items[0].external_id);
    if (adapter === 'stripe' || adapter === 'netsuite') expect(rows.items[0].record).not.toHaveProperty('price');
    if (adapter === 'zoho_inventory') expect(rows.items[0].source_version).toBe(time);
    if (adapter === 'googlesheets' || adapter === 'zoho_inventory') {
      const sheet = adapter === 'googlesheets';
      const mapping = { external_id: '_source_id', sku: sheet ? 'column_1' : 'sku', name: sheet ? 'column_2' : 'name',
        price: sheet ? 'column_3' : 'rate', price_format: 'decimal', ...(sheet ? { currency: 'column_4' } : { confirmed_currency: 'MYR' }) };
      const frozenRes = await f.call(`/imports/${job.id}/preview`, { revision: 1, mapping, selected_ids: [rows.items[0].external_id] });
      expect(frozenRes.status).toBe(200); const frozen = await frozenRes.json() as any;
      expect(frozen.preview.rows[0].unresolved).toEqual([]);
      const approved = await f.call(`/imports/${job.id}/approve`, { revision: frozen.revision, preview_hash: frozen.preview_hash, idempotency_key: crypto.randomUUID() });
      expect(approved.status).toBe(200);
      const source = await f.env.DB.prepare('SELECT toolkit,account_id,resource_json FROM integration_provenance WHERE job_id=?').bind(job.id).first<any>();
      expect(source).toMatchObject({ toolkit: adapter, account_id: connection.account_id });
    }
    // The only remote POST is the selected, pinned, non-destructive read. No raw proxy, model or provider write.
    expect(t.mock.calls.filter(([, init]) => init?.method === 'POST').every(([url]) => String(url).includes(`/tools/execute/${pin.slug}`))).toBe(true);
  });
});
