import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, mapping, product, providerTransport, tool } from '../../../packages/integrations/test/fixture';
import { customerFixture } from './customer-fixture';
import { approvePreview } from '../src/lib/integration-approve';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => f.dispose());
async function sourceJob(connection: { id: string; toolkit: string }, resource: object = { organization_id: 'org-meridian' }) {
  const selected = await f.call('/imports/select', { connection_id: connection.id, adapter: connection.toolkit, resource });
  expect(selected.status).toBe(201); return selected.json() as Promise<any>;
}
describe('persisted checkpoints, permissions and conflict recovery', () => {
  it('rejects foreign connections, toolkit changes and arbitrary source queries before executing a read', async () => {
    const connection = await f.createConnection(), t = providerTransport(() => { throw new Error('No provider calls expected'); });
    expect((await f.call('/imports/select', { connection_id: connection.id, adapter: 'zoho_inventory', resource: { organization_id: 'org-meridian' } }, { cookie: f.other.cookie })).status).toBe(404);
    expect((await f.call('/imports/select', { connection_id: connection.id, adapter: 'stripe', resource: { scope: 'selected_catalogue' } })).status).toBe(400);
    expect((await f.call('/imports/select', { connection_id: connection.id, adapter: 'zoho_inventory', resource: { organization_id: 'org-meridian', raw_tool: 'ZOHO_INVENTORY_DELETE_ITEM' } })).status).toBe(400);
    expect(t).not.toHaveBeenCalled();
  });
  it('resumes an interrupted lease, deduplicates source IDs and keeps partial approvals honest', async () => {
    const connection = await f.createConnection('zoho_books');
    // Zoho Books is deliberately unavailable while its recorded input regex is incompatible.
    const t = providerTransport(() => { throw new Error('Blocked adapter must not call provider'); });
    expect((await f.call('/imports/select', { connection_id: connection.id, adapter: 'zoho_books', resource: { organization_id: '123456' } })).status).toBe(409);
    expect(t).not.toHaveBeenCalled(); t.mockRestore();
    const owned = await f.env.DB.prepare("SELECT * FROM integration_connections WHERE workspace_id=? AND toolkit='zoho_inventory'").bind(f.owner.workspace).first<any>();
    const current = { id: owned.id, account_id: owned.account_id, toolkit: owned.toolkit, user_id: `pactovio-workspace-${f.owner.workspace}` };
    const pages: number[] = [];
    providerTransport((_method, path, body) => {
      if (path.startsWith('/connected_accounts/')) return { id: current.account_id, toolkit: { slug: current.toolkit }, user_id: current.user_id, status: 'ACTIVE' };
      if (path === `/tools/${tool('zoho_inventory').slug}`) return tool('zoho_inventory');
      pages.push(body.arguments.page);
      return { successful: true, data: { code: 0, message: 'success', items: body.arguments.page === 1
        ? Array.from({ length: 50 }, (_, i) => ({ item_id: `source-${i}`, name: `Meridian laser model ${i}`, sku: `LEASE-${i}`, rate: 10 }))
        : [{ item_id: 'source-0', name: 'Meridian laser model 0', sku: 'LEASE-0', rate: 10 }, { item_id: 'source-50', name: 'Meridian laser model 50', sku: 'LEASE-50', rate: 10 }] } };
    });
    const job = await sourceJob(current);
    await f.env.DB.prepare("UPDATE integration_jobs SET state='reading',read_token='interrupted',lease_until=? WHERE id=?").bind(Date.now() + 60000, job.id).run();
    expect((await f.call(`/imports/${job.id}/resume`, { revision: 0 })).status).toBe(409);
    expect(pages).toEqual([]);
    await f.env.DB.prepare('UPDATE integration_jobs SET lease_until=0 WHERE id=?').bind(job.id).run();
    const page = await f.call(`/imports/${job.id}/resume`, { revision: 0 }); expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ staged: 50, exhausted: false, revision: 1 });
    const frozen = await (await f.call(`/imports/${job.id}/preview`, { revision: 1, selected_ids: ['source-0'],
      mapping: { external_id: '_source_id', sku: 'sku', name: 'name', price: 'rate', confirmed_currency: 'MYR', price_format: 'decimal' } })).json() as any;
    expect((await f.call(`/imports/${job.id}/approve`, { revision: frozen.revision, preview_hash: frozen.preview_hash, idempotency_key: crypto.randomUUID() })).status).toBe(200);
    const partial = await (await f.call(`/imports/${job.id}`)).json() as any;
    expect(partial).toMatchObject({ state: 'partial', staged: 50, applied: 1, exhausted: false });
    expect((await f.call(`/imports/${job.id}/read`, { revision: partial.revision })).status).toBe(200);
    expect(await (await f.call(`/imports/${job.id}`)).json()).toMatchObject({ staged: 51, applied: 1, exhausted: true });
    expect(pages).toEqual([1, 2]);
  });
  it('rejects revoked or replaced source accounts after selection without reading from another account', async () => {
    const connection = await f.createConnection('xero'); let status = 'ACTIVE';
    const t = providerTransport(() => ({ id: connection.account_id, toolkit: { slug: 'xero' }, user_id: connection.user_id, status }));
    const job = await sourceJob(connection, { tenant_id: 'tenant-meridian' }); status = 'REVOKED';
    expect((await f.call(`/imports/${job.id}/read`, { revision: 0 })).status).toBe(409);
    expect((await (await f.call(`/imports/${job.id}`)).json() as any)).toMatchObject({ staged: 0, state: 'read_failed', error_code: 'connection_required' });
    await f.env.DB.prepare('UPDATE integration_connections SET account_id=? WHERE id=?').bind('ca_replacement', connection.id).run();
    const before = t.mock.calls.length;
    expect((await f.call(`/imports/${job.id}/resume`, { revision: 1 })).status).toBe(409);
    expect(t.mock.calls.length).toBe(before);
  });
  it('keeps zero staged rows and sanitized errors for malformed or partially failed source responses', async () => {
    const connection = await f.createConnection('hubspot'); let malformed = true;
    providerTransport((_method, path) => {
      if (path.startsWith('/connected_accounts/')) return { id: connection.account_id, toolkit: { slug: 'hubspot' }, user_id: connection.user_id, status: 'ACTIVE' };
      if (path === `/tools/${tool('hubspot').slug}`) return tool('hubspot');
      return malformed ? { successful: true, data: { results: 'sensitive-upstream-invalid' } } : { successful: true, data: {
        results: [], status: 'COMPLETE', startedAt: '2026-11-01T08:00:00Z', completedAt: '2026-11-01T08:00:00Z', numErrors: 1,
      } };
    });
    const job = await sourceJob(connection, { product_ids: ['product-laser'] });
    const first = await f.call(`/imports/${job.id}/read`, { revision: 0 }); expect(first.status).toBe(502); expect(await first.text()).not.toContain('sensitive');
    malformed = false;
    const second = await f.call(`/imports/${job.id}/resume`, { revision: 1 }); expect(second.status).toBe(502);
    expect(await second.json()).toMatchObject({ code: 'source_partial' });
    expect(await (await f.call(`/imports/${job.id}`)).json()).toMatchObject({ staged: 0, applied: 0, state: 'read_failed', revision: 2 });
  });
  it('stages, previews and approves the full 100-row boundary with immutable receipts and bounded D1 queries', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => product(`bulk-${i}`, `BULK-${i}`, '0.29'));
    const created = await f.call('/imports/tabular', { resource: 'hundred-lasers', rows, external_id_field: 'external_id' });
    expect(created.status).toBe(201); const job = await created.json() as any;
    const prepare = vi.spyOn(f.env.DB, 'prepare');
    const frozen = await (await f.call(`/imports/${job.id}/preview`, { revision: 0, mapping, selected_ids: rows.map(r => r.external_id) })).json() as any;
    const input = { revision: frozen.revision, preview_hash: frozen.preview_hash, idempotency_key: crypto.randomUUID() };
    expect((await f.call(`/imports/${job.id}/approve`, input)).status).toBe(200);
    expect(prepare.mock.calls.length).toBeLessThan(50);
    const receipt = await f.env.DB.prepare('SELECT frozen_preview_json FROM integration_approval_receipts WHERE job_id=?').bind(job.id).first<any>();
    expect(JSON.parse(receipt.frozen_preview_json).rows).toHaveLength(100);
    expect(await (await f.call(`/imports/${job.id}`)).json()).toMatchObject({ state: 'completed', staged: 100, applied: 100 });
    expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE workspace_id=? AND sku LIKE 'BULK-%' AND unit_price_minor=29").bind(f.owner.workspace).first()).toEqual({ n: 100 });
  });
  it('atomically resolves simultaneous identical approvals and rejects a revoked approving session', async () => {
    const selected = await (await f.call('/imports/tabular', { resource: 'concurrent-laser', rows: [product('concurrent-laser', 'CONCURRENT-1')], external_id_field: 'external_id' })).json() as any;
    const frozen = await (await f.call(`/imports/${selected.id}/preview`, { revision: 0, mapping, selected_ids: ['concurrent-laser'] })).json() as any;
    const input = { revision: frozen.revision, preview_hash: frozen.preview_hash, idempotency_key: crypto.randomUUID() };
    const responses = await Promise.all([f.call(`/imports/${selected.id}/approve`, input), f.call(`/imports/${selected.id}/approve`, input)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]); expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(await f.env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE workspace_id=? AND sku='CONCURRENT-1'").bind(f.owner.workspace).first()).toEqual({ n: 1 });
    const expired = await customerFixture(f.env, f.owner.workspace);
    await f.env.DB.prepare('UPDATE customer_sessions SET revoked_at=1 WHERE id=?').bind(expired.session).run();
    const next = await (await f.call('/imports/tabular', { resource: 'revoked-laser', rows: [product('revoked-laser', 'REVOKED-1')], external_id_field: 'external_id' })).json() as any;
    const preview = await (await f.call(`/imports/${next.id}/preview`, { revision: 0, mapping, selected_ids: ['revoked-laser'] })).json() as any;
    await expect(approvePreview(f.env, f.owner.workspace, next.id, { revision: preview.revision, preview_hash: preview.preview_hash, idempotency_key: crypto.randomUUID() }, expired.session)).rejects.toMatchObject({ code: 'preview_conflict' });
    expect(await f.env.DB.prepare("SELECT id FROM products WHERE sku='REVOKED-1'").first()).toBeNull();
  });
});
