import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { Composio } from '@pactovio/connectors';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';
import { customerFixture } from './customer-fixture';

let env: Env, dispose: () => Promise<void>, owner: Awaited<ReturnType<typeof customerFixture>>;
const { app } = buildApp();
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const KEY = 'integrations:public-native-catalog:v1';
const toolkit = (slug: string, overrides = {}) => ({ slug, name: slug === 'hubspot' ? 'HubSpot' : 'Zoho Inventory',
  auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'],
  meta: { description: 'Company products and records', categories: [{ name: 'crm' }], logo: 'https://assets.composio.dev/logos/company.png' }, ...overrides });
const call = (query = '', cookie = owner.cookie) => app.fetch(new Request(`http://localhost/api/integrations/catalog${query}`, { headers: { cookie } }), env, context);

beforeAll(async () => { ({ env, dispose } = await makeEnv()); owner = await customerFixture(env); }, 60000);
beforeEach(async () => { await env.CACHE.delete(KEY); env.COMPOSIO_API_KEY = 'test-project-key'; });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => dispose?.());

describe('authenticated integration discovery', () => {
  it('rejects signed-out requests and invalid/foreign-scope input before calling the provider', async () => {
    const request = vi.spyOn(Composio.prototype, 'request');
    expect((await call('', '')).status).toBe(401);
    for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?offset=1.5', '?workspace_id=other', '?search=' + 'x'.repeat(101)]) {
      expect((await call(query)).status).toBe(400);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('fetches every native catalogue page, reports real connection eligibility and never invents import support', async () => {
    const request = vi.spyOn(Composio.prototype, 'request')
      .mockResolvedValueOnce({ items: [toolkit('hubspot')], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ items: [toolkit('zoho_inventory')], next_cursor: null });
    const response = await call('?limit=1'); expect(response.status).toBe(200);
    const result = await response.json() as { items: { connection_provider: string | null; catalog_import: boolean; setup: string }[]; total: number; next_offset: number };
    expect(result).toMatchObject({ total: 2, catalog_total: 2, next_offset: 1 });
    expect(result.items[0]).toMatchObject({ connection_provider: 'hubspot', catalog_import: false, setup: 'managed_auth' });
    expect(request).toHaveBeenNthCalledWith(1, 'GET', '/toolkits', undefined, { type: 'native', limit: '1000', sort_by: 'alphabetically' });
    expect(request).toHaveBeenNthCalledWith(2, 'GET', '/toolkits', undefined, expect.objectContaining({ cursor: 'page-2' }));
    const next = await (await call('?offset=1&limit=1')).json() as { items: { connection_provider: null }[]; next_offset: null };
    expect(next.items[0]?.connection_provider).toBeNull(); expect(next.next_offset).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('filters cached metadata without more provider calls, omits provider secrets and rejects unsafe logo URLs', async () => {
    const request = vi.spyOn(Composio.prototype, 'request').mockResolvedValue({ items: [toolkit('shopify', {
      name: 'Shopify', composio_managed_auth_schemes: [], private_secret: 'never-return-this',
      meta: { description: 'Products in your store', logo: 'javascript:alert(1)', categories: [{ name: 'ecommerce' }] },
    }), toolkit('hubspot')], next_cursor: null });
    const response = await call('?search=SHOPIFY&category=ecommerce');
    const text = await response.text(); const result = JSON.parse(text);
    expect(result.total).toBe(1); expect(result.items[0]).toMatchObject({ slug: 'shopify', setup: 'own_credentials', logo: null, catalog_import: false });
    expect(text).not.toContain('never-return-this'); expect(text).not.toContain('test-project-key');
    expect((await (await call('?search=no-such-source')).json() as { items: unknown[] }).items).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('returns a recoverable safe error on provider failures without leaking diagnostics', async () => {
    vi.spyOn(Composio.prototype, 'request').mockRejectedValue(new Error('sensitive upstream stack and token'));
    const response = await call(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Could not load available integrations. Please try again.', code: 'integration_unavailable' });
    expect(await env.CACHE.get(KEY)).toBeNull();
  });
  it('rejects malformed pages and repeated pagination rather than caching partial success', async () => {
    const request = vi.spyOn(Composio.prototype, 'request').mockResolvedValue({ items: [toolkit('hubspot')], next_cursor: 'same-page' });
    expect((await call()).status).toBe(503); expect(request).toHaveBeenCalledTimes(2);
    expect(await env.CACHE.get(KEY)).toBeNull();
    request.mockResolvedValue({ items: [{ slug: '../private', name: 'Unsafe slug' }] });
    expect((await call()).status).toBe(503);
  });
  it('reports missing project configuration without exposing authentication configuration', async () => {
    env.COMPOSIO_API_KEY = undefined;
    const request = vi.spyOn(Composio.prototype, 'request'); const response = await call();
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'integration_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });
});
