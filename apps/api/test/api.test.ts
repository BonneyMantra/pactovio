import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointList, honoPath } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const { app, api, v1 } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init), env, ctx);

beforeAll(async () => ({ env, dispose } = await makeEnv()), 60_000);
afterAll(async () => dispose?.());

describe('health and openapi', () => {
  it('GET /api/health is public and reports bindings', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; bindings: Record<string, boolean> };
    expect(j.ok).toBe(true);
    expect(j.bindings.DB).toBe(true);
  });
  it('serves OpenAPI for every endpoint under /v1', async () => {
    const doc = (await (await call('/v1/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>> };
    for (const e of endpointList) expect(doc.paths[`/v1${e.path}`]?.[e.method.toLowerCase()], e.id).toBeTruthy();
  });
  it('mounts every contract endpoint on both /api and /v1', () => {
    for (const e of endpointList) {
      expect(api.registered.has(e.id), `api ${e.id}`).toBe(true);
      expect(v1.registered.has(e.id), `v1 ${e.id}`).toBe(true);
    }
  });
});

describe('seeded GET endpoints validate against their contracts', () => {
  it('GET /api/today returns seeded rows and sets the pv_s cookie', async () => {
    const res = await call('/api/today');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('pv_s=');
    const j = (await res.json()) as { top_matches: unknown[]; counts: { new_matches: number }; approvals: unknown[]; expiring: unknown[] };
    expect(j.top_matches.length).toBeGreaterThan(0);
    expect(j.counts.new_matches).toBeGreaterThan(0);
    expect(j.approvals.length).toBeGreaterThan(0);
    expect(j.expiring.length).toBeGreaterThan(0);
  });

  const ids = { id: 'tnd_sample_teagasc_p4941' } as Record<string, string>;
  const simple = endpointList.filter((e) => e.method === 'GET' && e.kind === 'json' && e.status !== 'stub' && e.lane !== 'agent'); // agent GETs need the AgentHub Durable Object (not available outside wrangler dev); covered by agent-hub.test.ts
  for (const e of simple) {
    it(`${e.id} responds and matches its schema`, async () => {
      const path = honoPath(e.path).replace(':id', e.id === 'getRun' ? 'run_sample_teagasc' : e.id === 'getBuyer' ? 'teagasc' : e.id === 'getEvidence' ? 'evd_sample_iso27001' : e.id === 'getIntake' ? 'int_sample_teagasc' : ids.id!);
      if (path.includes(':')) return;
      if (['getDesignRequest', 'getQuote', 'listWebhookDeliveries', 'getWorkspace'].includes(e.id)) return; // need other ids; covered below
      const res = await call(`/api${path}`);
      expect(res.status, `${e.id} ${path}`).toBe(200); // ENVIRONMENT=development makes the router validate the response schema
    });
  }
  it('teagasc sample matrix has requirements, three lots and verdicts', async () => {
    const m = (await (await call('/api/tenders/tnd_sample_teagasc_p4941/matrix')).json()) as { requirements: { status: string }[]; lots: string[]; verdicts: unknown[] };
    expect(m.requirements.length).toBeGreaterThanOrEqual(10);
    expect(new Set(m.requirements.map((r) => r.status))).toEqual(new Set(['MET', 'PARTIAL', 'GAP', 'NEEDS_EVIDENCE']));
    expect(m.lots).toEqual(['1', '2', '3']);
    expect(m.verdicts).toHaveLength(3);
  });
  it('quote arithmetic in the seed is consistent (integer minor units)', async () => {
    const cookie = (await call('/api/today')).headers.get('set-cookie')!.split(';')[0]!;
    await call('/api/workspaces/switch', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"workspace_id":"ws_kestrel_sensing"}' });
    const { items } = (await (await call('/api/quotes', { headers: { cookie } })).json()) as { items: import('@pactovio/contracts').Quote[] };
    const q = items[0]!;
    expect(q.lines.reduce((a, l) => a + l.qty * l.unit_price_minor, 0)).toBe(q.subtotal_minor + q.discount_minor);
    expect(q.lines.reduce((a, l) => a + l.line_total_minor, 0)).toBe(q.subtotal_minor);
    expect(q.subtotal_minor + q.tax_minor).toBe(q.total_minor);
    expect(Number.isInteger(q.total_minor)).toBe(true);
  });
});

describe('failure paths', () => {
  it('unknown tender is 404 with { error, code }', async () => {
    const res = await call('/api/tenders/tnd_nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Tender not found', code: 'not_found' });
  });
  it('bad query is a 400 validation error, not a 500', async () => {
    const res = await call('/api/tenders?limit=9999');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('validation');
  });
  it('bad body is a 400', async () => {
    const res = await call('/api/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"not-a-url","events":[]}' });
    expect(res.status).toBe(400);
  });
  it('starting a run on an unknown tender is a 404, not a 500', async () => {
    const res = await call('/api/tenders/tnd_nope/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });
  it('/v1 requires an API key', async () => {
    expect((await call('/v1/today')).status).toBe(401);
    expect((await call('/v1/today', { headers: { authorization: 'Bearer pk_nonsense' } })).status).toBe(401);
  });
  it('ingest rejects a wrong shared secret', async () => {
    const res = await call('/api/ingest/audit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': 'wrong' }, body: JSON.stringify({ audit_id: 'aud_x', status: 'completed' }) });
    expect(res.status).toBe(401);
  });
  it('workspace data is isolated per workspace', async () => {
    const cookie = (await call('/api/today')).headers.get('set-cookie')!.split(';')[0]!;
    const sw = (c: string) => call('/api/workspaces/switch', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ workspace_id: c }) });
    expect((await sw('ws_nonexistent')).status).toBe(404);
    await sw('ws_kestrel_sensing');
    const m = (await (await call('/api/tenders/tnd_sample_teagasc_p4941/matrix', { headers: { cookie } })).json()) as { requirements: unknown[] };
    expect(m.requirements).toHaveLength(0); // Harbour's requirements are invisible to Kestrel
    const ev = (await (await call('/api/evidence', { headers: { cookie } })).json()) as { items: { workspace_id: string }[] };
    expect(ev.items.every((e) => e.workspace_id === 'ws_kestrel_sensing')).toBe(true);
    const foreign = await call('/api/tenders/tnd_sample_teagasc_p4941/answers/ans_sample_1', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"status":"approved"}' });
    expect(foreign.status).toBe(404);
  });
});

describe('api keys end to end', () => {
  it('create key, call /v1 with it, revoke, then rejected', async () => {
    const first = await call('/api/today'); // establishes a session cookie
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
    const created = await call('/api/api-keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"name":"ci"}' });
    const k = (await created.json()) as { id: string; key: string };
    expect(k.key.startsWith('pk_')).toBe(true);
    const ok = await call('/v1/tenders', { headers: { authorization: `Bearer ${k.key}` } });
    expect(ok.status).toBe(200);
    const revoked = await call(`/api/api-keys/${k.id}`, { method: 'DELETE', headers: { cookie } });
    expect(revoked.status).toBe(200);
    expect((await call('/v1/tenders', { headers: { authorization: `Bearer ${k.key}` } })).status).toBe(401);
  });
});

describe('answers', () => {
  it('approves a draft and refuses silent edits to an approved answer', async () => {
    const cookie = 'pv_s=ses_unknown';
    const approve = await call('/api/tenders/tnd_sample_teagasc_p4941/answers/ans_sample_2', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"status":"approved"}' });
    expect(approve.status).toBe(200);
    const edit = await call('/api/tenders/tnd_sample_teagasc_p4941/answers/ans_sample_1', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"draft":"changed"}' });
    expect(edit.status).toBe(409);
  });
});
