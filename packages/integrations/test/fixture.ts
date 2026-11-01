import { Hono } from 'hono';
import { vi } from 'vitest';
import type { AppEnv } from '../../../apps/api/src/lib/types';
import { integrationWorkflowRoutes } from '../../../apps/api/src/routes/integration-workflows';
import { makeEnv } from '../../../apps/api/test/helpers';
import { customerFixture } from '../../../apps/api/test/customer-fixture';
import { pins, type Adapter } from '../../../apps/api/src/lib/integration-bindings';
import { workspaceUser } from '../../../apps/api/src/lib/integration-connections';
import { randomToken } from '../../../apps/api/src/lib/db';
export const mapping = { external_id: '_source_id', sku: 'sku', name: 'name', price: 'price', currency: 'currency', price_format: 'decimal' };
export const product = (external_id = 'meridian-laser', sku = 'ML-100', price: string | number = '12.34') => ({ external_id, sku, name: 'Meridian laser level', price, currency: 'MYR' });
export const metadata = (slug: string) => ({ slug, name: slug, type: 'native', auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], auth_config_details: [] });
export const tool = (adapter: Adapter) => ({ slug: pins[adapter].slug, name: adapter, version: pins[adapter].version,
  toolkit: { slug: adapter }, input_parameters: pins[adapter].input, output_parameters: pins[adapter].output,
  tags: pins[adapter].tags, scopes: pins[adapter].scopes, is_deprecated: false });
export async function fixture() {
  const { env, dispose } = await makeEnv();
  env.COMPOSIO_API_KEY = 'transport-test-placeholder'; env.COMPOSIO_CALLBACK_VERIFIER_ENABLED = 'true';
  Object.assign(env, { MODEL_DAILY_CAP_USD: '0.25', MODELS_DISABLED: 'true' }); await env.CACHE.put('config:models_disabled', '1');
  const owner = await customerFixture(env), other = await customerFixture(env), app = new Hono<AppEnv>();
  app.route('/api/integrations/workflows', integrationWorkflowRoutes);
  const context = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = async (path: string, input?: unknown, options: { cookie?: string; origin?: string | null; method?: string; raw?: string } = {}) => {
    const headers: Record<string, string> = { cookie: options.cookie ?? owner.cookie };
    if (options.origin !== null) headers.origin = options.origin ?? 'http://localhost';
    if (input !== undefined || options.raw !== undefined) headers['content-type'] = 'application/json';
    return app.fetch(new Request(`http://localhost/api/integrations/workflows${path}`, {
      method: options.method ?? (input === undefined && options.raw === undefined ? 'GET' : 'POST'), headers,
      ...(input !== undefined || options.raw !== undefined ? { body: options.raw ?? JSON.stringify(input) } : {}),
    }), env, context);
  };
  const createConnection = async (toolkit = 'zoho_inventory') => {
    const id = `icn_${randomToken(8)}`, account_id = `ca_${randomToken(8)}`;
    await env.DB.prepare("INSERT INTO integration_connections(id,workspace_id,toolkit,account_id,status,updated_at) VALUES(?,?,?,?,'active',?)")
      .bind(id, owner.workspace, toolkit, account_id, new Date().toISOString()).run();
    return { id, account_id, toolkit, user_id: workspaceUser(owner.workspace), status: 'ACTIVE' };
  };
  return { env, owner, other, call, createConnection, dispose };
}
/** Fake provider HTTP transport only. Database/auth/transactions are real local test harness code. */
export function providerTransport(handler: (method: string, path: string, body: any, url: URL) => unknown | Promise<unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== 'https://backend.composio.dev') throw new Error('Unexpected external request');
    const output = await handler(init?.method ?? 'GET', parsed.pathname.replace('/api/v3.1', ''), init?.body ? JSON.parse(String(init.body)) : undefined, parsed);
    return output instanceof Response ? output : new Response(JSON.stringify(output), { headers: { 'content-type': 'application/json' } });
  });
}
export const resources: Record<Adapter, object> = {
  zoho_inventory: { organization_id: 'org-meridian' }, zoho_books: { organization_id: 'org-meridian' },
  shopify: { scope: 'selected_catalogue' }, square: { scope: 'selected_catalogue' }, stripe: { scope: 'selected_catalogue' },
  quickbooks: { scope: 'selected_catalogue' }, xero: { tenant_id: 'tenant-meridian' }, hubspot: { scope: 'selected_catalogue' },
  salesforce: { pricebook_id: '01s000000000001AAA' }, pipedrive: { scope: 'selected_catalogue' },
  googlesheets: { spreadsheet_id: 'sheet-meridian', range: "'Inventory'!A1:F50" }, googledrive: { spreadsheet_id: 'sheet-meridian', range: 'Inventory!A1:F50' },
  excel: { drive_id: 'drive-meridian', item_id: 'file-meridian', table_id: 'LaserInventory' },
  airtable: { baseId: 'app12345678901234', tableIdOrName: 'Laser inventory' }, notion: { database_id: '0123456789abcdef0123456789abcdef' },
  netsuite: { scope: 'selected_catalogue' }, share_point: { site_name: 'meridian', list_title: 'Laser inventory' },
  erpnext: { item_code: 'ML-100', company: 'Meridian Instruments', price_list: 'Standard Selling', currency: 'MYR', conversion_rate: 1 },
};
