import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, providerTransport, tool } from '../../../packages/integrations/test/fixture';

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => f.dispose());
describe('complete catalogue imports in bounded approval batches', () => {
  it('lists and paginates HubSpot products without requiring customers to know product IDs', async () => {
    const connection = await f.createConnection('hubspot');
    const requests: Record<string, unknown>[] = [];
    providerTransport((_method, path, body) => {
      if (path.startsWith('/connected_accounts/')) return { id: connection.account_id, toolkit: { slug: 'hubspot' }, user_id: connection.user_id, status: 'ACTIVE' };
      if (path === `/tools/${tool('hubspot').slug}`) return tool('hubspot');
      requests.push(body.arguments);
      const second = body.arguments.after === 'next-products';
      return { successful: true, data: { results: [{ id: second ? 'hub-b' : 'hub-a', archived: false,
        createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
        properties: { name: 'Meridian field calibration', hs_sku: second ? 'HUB-B' : 'HUB-A', price: '12.34' } }],
        ...(!second ? { paging: { next: { after: 'next-products', link: 'https://api.hubapi.com/crm/v3/objects/products?after=next-products' } } } : {}) } };
    });
    const selected = await f.call('/imports/select', { connection_id: connection.id, adapter: 'hubspot', resource: { scope: 'selected_catalogue' } });
    expect(selected.status).toBe(201); let job = await selected.json() as any;
    for (let page = 0; page < 2; page++) {
      const result = await f.call(`/imports/${job.id}/read`, { revision: job.revision });
      expect(result.status).toBe(200); job = await result.json();
    }
    expect(job).toMatchObject({ staged: 2, exhausted: true });
    expect(requests).toEqual([
      { limit: 50, properties: ['name', 'hs_sku', 'price'], archived: false },
      { limit: 50, properties: ['name', 'hs_sku', 'price'], archived: false, after: 'next-products' },
    ]);
  });
  it('continues past500 total records after approval frees pending capacity, without resetting the source cursor', async () => {
    const connection = await f.createConnection('zoho_inventory');
    const ids = (n: number) => `bulk-${String(n).padStart(4, '0')}`;
    const pages: number[] = [];
    providerTransport((_method, path, body) => {
      if (path.startsWith('/connected_accounts/')) return { id: connection.account_id, toolkit: { slug: 'zoho_inventory' }, user_id: connection.user_id, status: 'ACTIVE' };
      if (path === `/tools/${tool('zoho_inventory').slug}`) return tool('zoho_inventory');
      const page = body.arguments.page; pages.push(page);
      return { successful: true, data: { code: 0, message: 'success', page_context: { has_more_page: true },
        items: Array.from({ length: 50 }, (_, index) => {
          const n = (page - 1) * 50 + index;
          return { item_id: ids(n), sku: `ML-${String(n).padStart(4, '0')}`, name: 'Meridian calibrated field instrument', rate: 12.34 };
        }) } };
    });
    let job = await (await f.call('/imports/select', { connection_id: connection.id, adapter: 'zoho_inventory', resource: { organization_id: 'org-meridian' } })).json() as any;
    for (let page = 0; page < 10; page++) {
      const result = await f.call(`/imports/${job.id}/read`, { revision: job.revision });
      expect(result.status).toBe(200); job = await result.json();
    }
    expect(job.staged).toBe(500);
    expect((await f.call(`/imports/${job.id}/read`, { revision: job.revision })).status).toBe(409);
    const frozenResult = await f.call(`/imports/${job.id}/preview`, { revision: job.revision,
      selected_ids: Array.from({ length: 100 }, (_, i) => ids(i)),
      mapping: { external_id: '_source_id', name: 'name', sku: 'sku', price: 'rate', price_format: 'decimal', confirmed_currency: 'MYR' } });
    expect(frozenResult.status).toBe(200); const frozen = await frozenResult.json() as any;
    const approved = await f.call(`/imports/${job.id}/approve`, { revision: frozen.revision, preview_hash: frozen.preview_hash, idempotency_key: crypto.randomUUID() });
    expect(approved.status).toBe(200);
    job = await (await f.call(`/imports/${job.id}`)).json();
    const next = await f.call(`/imports/${job.id}/resume`, { revision: job.revision });
    expect(next.status).toBe(200); job = await next.json();
    expect(job).toMatchObject({ staged: 550, applied: 100, exhausted: false });
    expect(pages).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    const pending = await (await f.call(`/imports/${job.id}/rows?pending=true`)).json() as any;
    expect(pending.items[0].external_id).toBe(ids(100)); expect(pending.items.every((r: any) => !r.applied)).toBe(true);
    const audit = await f.call(`/imports/${job.id}/rows?offset=500`);
    expect(audit.status).toBe(200); expect((await audit.json() as any).items[0].external_id).toBe(ids(500));
  });
});
