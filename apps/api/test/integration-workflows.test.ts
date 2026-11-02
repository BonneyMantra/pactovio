import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, mapping, product, providerTransport, tool } from '../../../packages/integrations/test/fixture';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); }, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => f.dispose());
async function table(rows = [product()], resource = crypto.randomUUID()) {
  const res = await f.call('/imports/tabular', { rows, resource, external_id_field: 'external_id' });
  expect(res.status).toBe(201); return res.json() as Promise<any>;
}
async function preview(job: any, extra = {}) {
  const res = await f.call(`/imports/${job.id}/preview`, { revision: job.revision, mapping,
    selected_ids: [product().external_id], ...extra });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const approval = (job: any, key = crypto.randomUUID()) => ({ revision: job.revision, preview_hash: job.preview_hash, idempotency_key: key });
describe('private staged import and exact approval', () => {
  it('requires customer auth and Origin for every mutation, without provider traffic', async () => {
    const transport = providerTransport(() => { throw new Error('Must not reach provider'); });
    expect((await f.call('/connections', undefined, { cookie: '' })).status).toBe(401);
    expect((await f.call('/imports/tabular', {}, { origin: null })).status).toBe(403);
    expect((await f.call('/imports/select', {}, { origin: 'https://foreign.example' })).status).toBe(403);
    expect((await f.call('/imports/tabular?workspace_id=foreign', {})).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects foreign jobs and row access, client account authority, oversized/malformed bodies and invalid mappings', async () => {
    const job = await table();
    expect((await f.call(`/imports/${job.id}`, undefined, { cookie: f.other.cookie })).status).toBe(404);
    expect((await f.call(`/imports/${job.id}/rows`, undefined, { cookie: f.other.cookie })).status).toBe(404);
    expect((await f.call(`/imports/${job.id}/preview`, { revision: 0, mapping, selected_ids: [product().external_id] }, { cookie: f.other.cookie })).status).toBe(404);
    expect((await f.call('/imports/select', { connection_id: 'foreign', adapter: 'stripe', resource: {}, account_id: 'injected' })).status).toBe(400);
    expect((await f.call('/imports/tabular', undefined, { raw: '{broken' })).status).toBe(400);
    expect((await f.call('/imports/tabular', undefined, { raw: ' '.repeat(256001) })).status).toBe(413);
    expect((await f.call('/imports/tabular', { resource: 'inventory', external_id_field: 'external_id', rows: Array(101).fill(product()) })).status).toBe(400);
    expect((await f.call(`/imports/${job.id}/preview`, { revision: 0, mapping: { ...mapping, price_format: 'guessed' }, selected_ids: [] })).status).toBe(400);
    expect((await f.call('/imports/tabular', { resource: 'inventory', external_id_field: 'external_id', rows: [{ ...product(), access_token: 'sensitive' }] })).status).toBe(400);
  });
  it('stages, freezes and idempotently approves local catalogue writes with source provenance', async () => {
    const job = await table(), frozen = await preview(job), input = approval(frozen);
    expect(frozen).toMatchObject({ state: 'preview', staged: 1, applied: 0, exhausted: true });
    expect(frozen.preview.rows[0]).toMatchObject({ unresolved: [], product: { unit_price_minor: 1234, currency: 'MYR' } });
    const response = await f.call(`/imports/${job.id}/approve`, input); expect(response.status).toBe(200);
    const result = await response.json();
    expect(await (await f.call(`/imports/${job.id}/approve`, input)).json()).toEqual(result);
    const status = await (await f.call(`/imports/${job.id}`)).json() as any;
    expect(status).toMatchObject({ state: 'completed', staged: 1, applied: 1 });
    const provenance = await f.env.DB.prepare('SELECT * FROM integration_provenance WHERE job_id=?').bind(job.id).first<any>();
    expect(provenance).toMatchObject({ toolkit: 'tabular', account_id: null, external_id: product().external_id, product_revision: 1 });
    expect(provenance.retrieved_at).toBeTruthy();
    expect((await f.call(`/imports/${job.id}/approve`, { ...input, preview_hash: 'a'.repeat(64) })).status).toBe(409);
  });
  it('keeps missing fields and inexact prices unresolved; explicit customer resolutions are preserved', async () => {
    const row = { external_id: 'meridian-laser', sku: '', name: '', price: '1.005', currency: 'JPY' };
    const job = await table([row]), frozen = await preview(job);
    expect(frozen.preview.rows[0].product).toBeNull();
    expect(frozen.preview.rows[0].unresolved.sort()).toEqual(['currency', 'name', 'sku', 'unit_price_minor'].sort());
    expect((await f.call(`/imports/${job.id}/approve`, approval(frozen))).status).toBe(409);
    const resolved = await preview(frozen, { resolutions: [{ external_id: row.external_id, product: {
      sku: 'ML-RESOLVED', name: 'Meridian laser level', unit_price_minor: 29, currency: 'MYR' } }] });
    expect(resolved.preview.rows[0].product.unit_price_minor).toBe(29);
    expect((await f.call(`/imports/${job.id}/approve`, approval(resolved))).status).toBe(200);
    expect(JSON.parse((await f.env.DB.prepare('SELECT resolution_json FROM integration_provenance WHERE job_id=?').bind(job.id).first<any>())!.resolution_json)).toMatchObject({ unit_price_minor: 29 });
  });
  it('rejects stale preview hashes and duplicate IDs/SKUs without importing anything', async () => {
    const rows = [product('one', 'DUP-1'), product('two', 'DUP-1')];
    const job = await table(rows), frozen = await preview(job, { selected_ids: ['one', 'two'] });
    expect(frozen.preview.rows.every((r: any) => r.unresolved.includes('duplicate_sku'))).toBe(true);
    expect((await f.call(`/imports/${job.id}/approve`, approval(frozen))).status).toBe(409);
    const newer = await preview(frozen, { selected_ids: ['one'], resolutions: [] });
    expect((await f.call(`/imports/${job.id}/approve`, approval(frozen))).status).toBe(409);
    expect((await f.call(`/imports/${job.id}/approve`, approval(newer))).status).toBe(200);
    expect((await (await f.call(`/imports/${job.id}`)).json() as any).state).toBe('partial');
    expect((await f.call('/imports/tabular', { resource: 'inventory', rows: [product(), product()], external_id_field: 'external_id' })).status).toBe(400);
  });
  it('rolls back every row if a manual edit or concurrent duplicate invalidates any frozen target', async () => {
    const resource = crypto.randomUUID(), first = await table([product('meridian-laser', 'MANUAL-1')], resource);
    const initial = await preview(first); expect((await f.call(`/imports/${first.id}/approve`, approval(initial))).status).toBe(200);
    const target = initial.preview.rows[0].target_id;
    const second = await table([product('meridian-laser', 'MANUAL-1', '50.00'), product('new-row', 'NEW-ATOMIC')], resource);
    const frozen = await preview(second, { selected_ids: ['new-row', 'meridian-laser'] });
    await f.env.DB.prepare("UPDATE products SET name='Manually corrected laser' WHERE id=?").bind(target).run();
    expect((await f.call(`/imports/${second.id}/approve`, approval(frozen))).status).toBe(409);
    expect(await f.env.DB.prepare("SELECT id FROM products WHERE sku='NEW-ATOMIC'").first()).toBeNull();
    expect(await f.env.DB.prepare('SELECT name,unit_price_minor FROM products WHERE id=?').bind(target).first()).toMatchObject({ name: 'Manually corrected laser', unit_price_minor: 1234 });
    const repreview = await preview(frozen, { selected_ids: ['meridian-laser'] });
    expect(repreview.preview.rows[0].unresolved).toContain('manual_edit_conflict');
  });
  it('updates a prior imported record when its target revision is unchanged, leaving other tenants intact', async () => {
    const resource = crypto.randomUUID(), first = await table([product('meridian-laser', 'UPDATE-1')], resource);
    const initial = await preview(first); await f.call(`/imports/${first.id}/approve`, approval(initial));
    const other = await f.env.DB.prepare(`INSERT INTO products(id,workspace_id,sku,name,unit_price_minor,currency) VALUES('foreign-product',?,'UPDATE-1','Other company laser',100,'MYR')`)
      .bind(f.other.workspace).run();
    expect(other.success).toBe(true);
    const second = await table([product('meridian-laser', 'UPDATE-1', '0.29')], resource), frozen = await preview(second);
    expect((await f.call(`/imports/${second.id}/approve`, approval(frozen))).status).toBe(200);
    expect(await f.env.DB.prepare('SELECT unit_price_minor FROM products WHERE id=?').bind(initial.preview.rows[0].target_id).first()).toMatchObject({ unit_price_minor: 29 });
    expect(await f.env.DB.prepare("SELECT unit_price_minor FROM products WHERE id='foreign-product'").first()).toMatchObject({ unit_price_minor: 100 });
  });
  it('persists read failures and resumes from the actual checkpoint, never replaying successful pages', async () => {
    const connection = await f.createConnection(), pin = tool('zoho_inventory'); let fail = true;
    const transport = providerTransport((method, path, body) => {
      if (path === `/connected_accounts/${connection.account_id}`) return { ...connection, id: connection.account_id, toolkit: { slug: connection.toolkit } };
      if (path === `/tools/${pin.slug}`) return pin;
      if (path === `/tools/execute/${pin.slug}`) {
        expect(body.arguments).toEqual({ organization_id: 'org-meridian', page: 1, per_page: 50 });
        if (fail) return { successful: false, error: 'sensitive upstream error' };
        return { successful: true, data: { code: 0, message: 'success', items: [{ item_id: 'source-laser', name: 'Meridian laser', rate: 12.34 }] } };
      }
      throw new Error('Unexpected provider operation');
    });
    const selected = await (await f.call('/imports/select', { connection_id: connection.id, adapter: 'zoho_inventory', resource: { organization_id: 'org-meridian' } })).json() as any;
    const failed = await f.call(`/imports/${selected.id}/read`, { revision: 0 }); expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('sensitive');
    const checkpoint = await (await f.call(`/imports/${selected.id}`)).json() as any;
    expect(checkpoint).toMatchObject({ state: 'read_failed', staged: 0, revision: 1 });
    fail = false;
    const read = await f.call(`/imports/${selected.id}/resume`, { revision: checkpoint.revision }); expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: 'staged', staged: 1, exhausted: true });
    const calls = transport.mock.calls.length;
    expect((await f.call(`/imports/${selected.id}/resume`, { revision: 2 })).status).toBe(409);
    expect(transport.mock.calls.length).toBe(calls);
  });
});
