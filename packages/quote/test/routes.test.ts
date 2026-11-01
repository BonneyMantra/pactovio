import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../../../apps/api/src/app';
import { createQuote } from '../src';
import { makeSampleEnv } from './helpers';
import { customerFixture } from '../../../apps/api/test/customer-fixture';

let env: Env;
let dispose: () => Promise<void>;
let cookie = '';
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
let keyless = false;
const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: 'http://localhost', cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) } }), keyless ? ({ ...env, NEBIUS_API_KEY: undefined } as Env) : env, ctx);

beforeAll(async () => {
  ({ env, dispose } = await makeSampleEnv());
  cookie = (await customerFixture(env, 'ws_kestrel_sensing')).cookie;
  const sw = await call('/api/workspaces/switch', { method: 'POST', body: JSON.stringify({ workspace_id: 'ws_kestrel_sensing' }) });
  expect(sw.status).toBe(200);
}, 90_000);
afterAll(async () => dispose?.());

describe('design and quote routes', () => {
  it('lists the three seeded design requests and ten products for the Kestrel session', async () => {
    const d = (await (await call('/api/design-requests')).json()) as { items: { id: string }[] };
    expect(d.items.map((x) => x.id)).toEqual(expect.arrayContaining(['dsg_sample_westbay', 'dsg_k_nordwind', 'dsg_k_kilbrook']));
    expect(((await (await call('/api/products')).json()) as { items: unknown[] }).items).toHaveLength(10);
  });
  it('POST match without model access fails cleanly as 502 { error, code } and marks the run failed', async () => {
    keyless = true; // never let a unit test reach the live model API
    const res = await call('/api/design-requests/dsg_k_kilbrook/match', { method: 'POST', body: '{}' });
    keyless = false;
    const body = (await res.json()) as { error: string; code: string };
    expect(res.status).toBe(502);
    expect(body.code).toBe('upstream');
    expect(JSON.stringify(body)).not.toMatch(/NEBIUS|sk-|stack/i);
    const run = await env.DB.prepare("SELECT status FROM runs WHERE subject_id = 'dsg_k_kilbrook'").first<{ status: string }>();
    expect(run?.status).toBe('failed');
  });
  it('POST match on another workspace\'s request is 404; POST quote before match is 409', async () => {
    expect((await call('/api/design-requests/nope/match', { method: 'POST', body: '{}' })).status).toBe(404);
    const res = await call('/api/design-requests/dsg_k_nordwind/quote', { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
  });
  it('POST quote with explicit products creates a quote that reads back and exports to DOCX and XLSX', async () => {
    const res = await call('/api/design-requests/dsg_sample_westbay/quote', { method: 'POST', body: JSON.stringify({ product_ids: ['prd_k_vs210', 'prd_k_gw4g'], qty: 6 }) });
    expect(res.status).toBe(200);
    const q = (await res.json()) as { id: string; total_minor: number };
    expect(((await (await call(`/api/quotes/${q.id}`)).json()) as { total_minor: number }).total_minor).toBe(q.total_minor);
    for (const [fmt, part] of [['docx', 'word/document.xml'], ['xlsx', 'xl/worksheets/sheet1.xml']] as const) {
      const ex = await call(`/api/quotes/${q.id}/export?format=${fmt}`);
      expect(ex.status).toBe(200);
      expect(ex.headers.get('content-disposition')).toContain(`.${fmt}`);
      expect(Object.keys(unzipSync(new Uint8Array(await ex.arrayBuffer())))).toContain(part);
    }
    expect((await call('/api/quotes/quo_missing/export?format=docx')).status).toBe(404);
    expect((await call(`/api/quotes/${q.id}/export?format=pdf`)).status).toBe(400);
  });
  it('a quote is not visible from the other workspace', async () => {
    const q = await createQuote(env, { workspaceId: 'ws_kestrel_sensing', productIds: ['prd_k_mm3'], qty: 1 });
    const otherCustomer = await customerFixture(env);
    const other = await app.fetch(new Request(`http://localhost/api/quotes/${q.id}`, { headers: { cookie: otherCustomer.cookie } }), env, ctx);
    expect(other.status).toBe(404);
  });
});
