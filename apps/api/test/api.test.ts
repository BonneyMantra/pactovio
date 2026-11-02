import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointList, honoPath } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';
import { customerFixture } from './customer-fixture';

let env: Env, dispose: () => Promise<void>, cookie: string, other: string;
const { app, api, v1 } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, {
  ...init, headers: { cookie, origin: 'http://localhost', ...(init.headers as Record<string, string>) },
}), env, ctx);
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  // Seeded documents exercise existing API contracts under a persisted customer fixture.
  cookie = (await customerFixture(env, 'ws_harbour_digital')).cookie;
  other = (await customerFixture(env, 'ws_kestrel_sensing')).cookie;
}, 60000);
afterAll(async () => dispose?.());

describe('public metadata and contract registration', () => {
  it('health is public; OpenAPI and both endpoint registries stay complete', async () => {
    expect((await call('/api/health', { headers: { cookie: '' } })).status).toBe(200);
    const doc = await (await call('/v1/openapi.json')).json() as any;
    for (const e of endpointList) {
      expect(doc.paths[`/v1${e.path}`]?.[e.method.toLowerCase()], e.id).toBeTruthy();
      expect(api.registered.has(e.id), e.id).toBe(true);
      expect(v1.registered.has(e.id), e.id).toBe(true);
    }
  });
});

describe('seeded authenticated endpoint regressions', () => {
  const simple = endpointList.filter((e) => e.method === 'GET' && e.kind === 'json' && e.status !== 'stub' && e.lane !== 'agent');
  for (const e of simple) it(`${e.id} matches its response schema`, async () => {
    const id = e.id === 'getRun' ? 'run_sample_teagasc' : e.id === 'getBuyer' ? 'teagasc' : e.id === 'getEvidence' ? 'evd_sample_iso27001' : e.id === 'getIntake' ? 'int_sample_teagasc' : 'tnd_sample_teagasc_p4941';
    const path = honoPath(e.path).replace(':id', id);
    if (path.includes(':') || ['getDesignRequest', 'getQuote', 'listWebhookDeliveries', 'getWorkspace'].includes(e.id)) return;
    const res = await call(`/api${path}`);
    expect(res.status, `${e.id}: ${await res.clone().text()}`).toBe(200);
    expect(e.response.safeParse(await res.json()).success, e.id).toBe(true);
  });
  it('matrix keeps the three seeded lots and verdicts', async () => {
    const m = await (await call('/api/tenders/tnd_sample_teagasc_p4941/matrix')).json() as any;
    expect(m.lots).toEqual(['1', '2', '3']); expect(m.verdicts).toHaveLength(3);
    expect(m.requirements.length).toBeGreaterThanOrEqual(10);
  });
  it('quote totals use integer minor units', async () => {
    const { items } = await (await call('/api/quotes', { headers: { cookie: other } })).json() as any;
    const q = items[0];
    expect(q.lines.reduce((a: number, l: any) => a + l.line_total_minor, 0)).toBe(q.subtotal_minor);
    expect(q.subtotal_minor + q.tax_minor).toBe(q.total_minor);
    expect(Number.isInteger(q.total_minor)).toBe(true);
  });
});

describe('failures and private workspace authority', () => {
  it('unknown IDs and invalid queries/bodies keep safe structured errors', async () => {
    const unknown = await call('/api/tenders/tnd_nope');
    expect(unknown.status).toBe(404); expect(await unknown.json()).toEqual({ error: 'Tender not found', code: 'not_found' });
    expect((await call('/api/tenders?limit=9999')).status).toBe(400);
    expect((await call('/api/webhooks', json({ url: 'not-a-url', events: [] }))).status).toBe(400);
    expect((await call('/api/tenders/tnd_nope/runs', json({}))).status).toBe(404);
    expect((await call('/v1/today')).status).toBe(401);
    expect((await call('/api/ingest/audit', { ...json({ audit_id: 'aud_x', status: 'completed' }), headers: { 'x-ingest-secret': 'wrong' } })).status).toBe(401);
  });
  it('does not enumerate or switch to other workspaces and hides foreign evidence/answers', async () => {
    const ws = await (await call('/api/workspaces')).json() as any;
    expect(ws.items.map((w: any) => w.id)).toEqual(['ws_harbour_digital']);
    expect((await call('/api/workspaces/ws_kestrel_sensing')).status).toBe(404);
    expect((await call('/api/workspaces/switch', json({ workspace_id: 'ws_kestrel_sensing' }))).status).toBe(403);
    const foreign = await call('/api/evidence/evd_sample_iso27001', { headers: { cookie: other } });
    expect(foreign.status).toBe(404);
    expect((await call('/api/tenders/tnd_sample_teagasc_p4941/answers/ans_sample_1', { ...json({ status: 'approved' }), method: 'PATCH', headers: { cookie: other, 'content-type': 'application/json' } })).status).toBe(404);
  });
  it('creates, hashes and revokes a customer API key', async () => {
    const res = await call('/api/api-keys', json({ name: 'Customer automation' }));
    expect(res.status).toBe(200);
    const k = await res.json() as any;
    const auth = { authorization: `Bearer ${k.key}` };
    expect((await call('/v1/tenders', { headers: auth })).status).toBe(200);
    expect(JSON.stringify(await (await call('/api/api-keys')).json())).not.toContain(k.key);
    expect((await call(`/api/api-keys/${k.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/v1/tenders', { headers: auth })).status).toBe(401);
  });
  it('approval still requires explicitly reopening an answer before changing its text', async () => {
    expect((await call('/api/tenders/tnd_sample_teagasc_p4941/answers/ans_sample_2', { ...json({ status: 'approved' }), method: 'PATCH' })).status).toBe(200);
    expect((await call('/api/tenders/tnd_sample_teagasc_p4941/answers/ans_sample_1', { ...json({ draft: 'changed' }), method: 'PATCH' })).status).toBe(409);
  });
});
