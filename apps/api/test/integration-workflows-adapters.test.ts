import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, metadata, providerTransport, tool, resources } from '../../../packages/integrations/test/fixture';
import { adapters, pins, readArguments, selections, bindingIssue, type Adapter } from '../src/lib/integration-bindings';
import { boundTool, decodePage, readSelected } from '../src/lib/integration-read';
import { matchesSchema } from '../src/lib/integration-schema';
import { priceMinor } from '../src/lib/integration-input';
import { toolkitDetail } from '../src/lib/integration-detail';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => f.dispose());
describe('explicit version-bound read capabilities', () => {
  it.each(adapters)('%s builds schema-valid resource-bound reads from the recorded official API schema', adapter => {
    const args = readArguments(adapter, resources[adapter], null);
    expect(matchesSchema(args, pins[adapter].input)).toBe(!bindingIssue(adapter));
    expect(pins[adapter].tags).toContain('readOnlyHint');
    expect(pins[adapter].tags).not.toContain('destructiveHint');
    expect(Object.keys(args).some(k => /token|credential|custom_auth|connected_account/.test(k))).toBe(false);
    expect(selections[adapter].safeParse({ ...resources[adapter], query: 'DELETE everything' }).success).toBe(false);
  });
  it('validates exact currency/decimal/minor amounts without rounding or invented zeros', () => {
    for (const [value, expected] of [['0', 0], ['0.29', 29], ['999.99', 99999], [12.34, 1234], ['10000000000', 1000000000000]] as const) expect(priceMinor(value, 'decimal')).toBe(expected);
    for (const value of ['', null, undefined, '1.005', '1e3', '-1', 'NaN', '1,000.00', '10000000000.01', true]) expect(priceMinor(value, 'decimal')).toBeNull();
    expect(priceMinor('1234', 'minor')).toBe(1234); expect(priceMinor('12.34', 'minor')).toBeNull();
  });
  it('rejects excessive ranges, dynamic queries and unselected resource scope', () => {
    for (const range of ['A1', 'Inventory!A1:ZZ99999', 'Inventory!A1:A101', 'Inventory!A1:BY2', 'Inventory!A3:A1']) {
      expect(selections.googlesheets.safeParse({ spreadsheet_id: 'sheet-meridian', range }).success).toBe(false);
    }
    expect(selections.salesforce.safeParse({ pricebook_id: "' OR 1=1" }).success).toBe(false);
    expect(selections.hubspot.safeParse({ product_ids: [] }).success).toBe(false);
    expect(selections.stripe.safeParse({ scope: 'all_accounts' }).success).toBe(false);
  });
  it('pins full structural inputs/outputs, version, toolkit, tags and scopes before any execute', async () => {
    let changed: any = tool('zoho_inventory');
    const t = providerTransport(() => changed);
    await expect(boundTool(f.env, 'zoho_inventory')).resolves.toMatchObject({ slug: pins.zoho_inventory.slug });
    const original = tool('zoho_inventory');
    for (const change of [{ version: 'changed' }, { toolkit: { slug: 'foreign' } }, { is_deprecated: true },
      { tags: [...original.tags, 'createHint'] }, { scopes: ['write.all'] }, { input_parameters: { type: 'object' } }, { output_parameters: { type: 'array' } }]) {
      changed = { ...original, ...change }; await expect(boundTool(f.env, 'zoho_inventory')).rejects.toMatchObject({ code: 'adapter_changed' });
    }
    expect(t.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('does not authorize tools because SPREADSHEET contains read or because a provider labels them readOnlyHint', async () => {
    providerTransport((_method, path) => path.startsWith('/toolkits/') ? metadata('odoo') : path === '/auth_configs' ? { items: [], next_cursor: null } : {
      items: [{ slug: 'ODOO_CREATE_SPREADSHEET', name: 'Create spreadsheet', version: '20261030_00', toolkit: { slug: 'odoo' }, tags: ['readOnlyHint'] }], next_cursor: null,
    });
    expect((await toolkitDetail(f.env, 'odoo')).catalog_import).toMatchObject({ availability: 'discovery_only' });
    const result = await (await f.call('/toolkits/odoo/operations')).json() as any;
    expect(result.items[0]).toMatchObject({ read_only_hint: true, execution: 'discovery_only' });
    expect((await f.call('/imports/select', { connection_id: 'anything', adapter: 'odoo', resource: {} })).status).toBe(409);
    expect((await f.call('/tools/execute/ODOO_CREATE_SPREADSHEET', {})).status).toBe(404);
  });
  it('fetches actual detail requirements and strips every credential/config default and secret field', async () => {
    providerTransport((_method, path) => {
      if (path.startsWith('/toolkits/')) return { ...metadata('zoho_inventory'), secret: 'never-return',
        auth_config_details: [{ mode: 'OAUTH2', required_scopes: ['ZohoInventory.items.READ'], fields: {
          auth_config_creation: { required: [{ name: 'client_secret', is_secret: true, default: 'never-return' }] },
          connected_account_initiation: { required: [{ name: 'organization', default: 'never-return' }] },
        } }] };
      if (path === '/auth_configs') return { items: [{ id: 'config-private', toolkit: { slug: 'zoho_inventory' }, status: 'ENABLED', auth_scheme: 'OAUTH2', is_composio_managed: true, credentials: { secret: 'never-return' } }] };
      return tool('zoho_inventory');
    });
    const response = await f.call('/toolkits/zoho_inventory'), text = await response.text(); expect(response.status).toBe(200);
    expect(text).not.toContain('never-return'); expect(text).not.toContain('config-private'); expect(text).not.toContain('client_secret');
    expect(JSON.parse(text)).toMatchObject({ connection: { availability: 'ready' }, catalog_import: { availability: 'available' },
      auth_requirements: [{ scheme: 'OAUTH2', required_scopes: ['ZohoInventory.items.READ'], configuration_field_count: 1, account_field_count: 1 }] });
  });
  it('decodes only the declared source shape and preserves partial pagination', () => {
    const first = decodePage('zoho_books', { code: 0, items: Array.from({ length: 50 }, (_, i) => ({ item_id: `z-${i}`, rate: 10 })), page_context: { has_more_page: true } }, null);
    expect(first).toMatchObject({ exhausted: false, next: 2 }); expect(first.rows).toHaveLength(50);
    expect(first.rows[0].record).not.toHaveProperty('currency'); expect(first.rows[0].record).not.toHaveProperty('sku');
    const sheets = decodePage('googlesheets', { values: [['SKU', 'Name', 'Price'], ['ML-1', 'Laser level', 12.34]] }, null);
    expect(sheets.rows[1]).toMatchObject({ external_id: 'row_2', record: { column_1: 'ML-1', column_3: 12.34 } });
    const excel = decodePage('excel', { rows: [{ index: 50, values: [['ML-1', 12.34]] }], odata_next_link: 'https://graph.microsoft.com/owned-page' }, 50);
    expect(excel).toMatchObject({ next: 100, exhausted: false });
    expect(decodePage('shopify', { products: [{ id: 1, title: 'Laser', variants: [{ id: 2, sku: 'ML-1', price: '12.34' }] }] }, null).rows[0]).toMatchObject({ external_id: '2', record: { product_name: 'Laser' } });
    for (const data of [null, { items: {} }, { items: [{ name: 'No identity' }] }, { items: [{ item_id: 'same' }, { item_id: 'same' }] }]) {
      expect(() => decodePage('zoho_inventory', data, null)).toThrow();
    }
    expect(() => decodePage('hubspot', { results: [], numErrors: 1 }, null)).toThrow();
  });
  it('verifies the live account identity before every source read and rejects malformed provider values', async () => {
    const connection = await f.createConnection('stripe');
    const row = await f.env.DB.prepare('SELECT * FROM integration_connections WHERE id=?').bind(connection.id).first<any>();
    let foreign = true, malformed = false;
    const t = providerTransport((_method, path, body) => {
      if (path.startsWith('/connected_accounts/')) return { id: connection.account_id, toolkit: { slug: 'stripe' }, user_id: foreign ? 'foreign-workspace' : connection.user_id, status: 'ACTIVE' };
      if (path === `/tools/${pins.stripe.slug}`) return tool('stripe');
      if (path === `/tools/execute/${pins.stripe.slug}`) {
        expect(body).toMatchObject({ connected_account_id: connection.account_id, user_id: connection.user_id, version: pins.stripe.version, arguments: { active: true, limit: 50 } });
        return { successful: true, data: { data: malformed ? 'bad-array' : [], object: 'list', url: '/v1/products', has_more: false } };
      }
      throw new Error('Unexpected operation');
    });
    await expect(readSelected(f.env, row, 'stripe', resources.stripe, null)).rejects.toMatchObject({ code: 'connection_required' });
    expect(t.mock.calls).toHaveLength(1);
    foreign = false;
    await expect(readSelected(f.env, row, 'stripe', resources.stripe, null)).resolves.toMatchObject({ exhausted: true, rows: [] });
    malformed = true;
    await expect(readSelected(f.env, row, 'stripe', resources.stripe, null)).rejects.toMatchObject({ code: 'source_malformed' });
  });
});
