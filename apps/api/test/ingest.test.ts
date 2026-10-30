import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { safeEqual } from '../src/routes/ingest';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init), env, ctx);
const SECRET = 'test-ingest-secret';
const auth = { 'x-ingest-secret': SECRET, 'content-type': 'application/json' };

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env.INGEST_SECRET = SECRET;
  await env.DB.prepare("INSERT INTO audits (id, workspace_id, subject_type, subject_id, status, created_at) VALUES ('aud_t1','ws_harbour_digital','tender','tnd_sample_teagasc_p4941','queued','2026-10-30T00:00:00Z')").run();
}, 60_000);
afterAll(async () => dispose?.());

describe('safeEqual', () => {
  it('compares equal and different strings, including length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('ingest audit routes', () => {
  it('rejects a missing or wrong secret on queue and results', async () => {
    expect((await call('/api/ingest/audit/queue')).status).toBe(401);
    expect((await call('/api/ingest/audit/queue', { headers: { 'x-ingest-secret': 'nope' } })).status).toBe(401);
    expect((await call('/api/ingest/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audit_id: 'aud_t1', status: 'completed' }) })).status).toBe(401);
  });
  it('queue returns answers with their evidence; claim=1 marks running', async () => {
    const res = await call('/api/ingest/audit/queue?claim=1&job_id=job_x', { headers: auth });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { items: { audit_id: string; answers: { draft: string; evidence: { text: string }[] }[] }[] };
    expect(j.items.map((i) => i.audit_id)).toContain('aud_t1');
    const a = j.items.find((i) => i.audit_id === 'aud_t1')!.answers;
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((x) => x.evidence.length > 0)).toBe(true);
    const row = await env.DB.prepare("SELECT status, job_id FROM audits WHERE id='aud_t1'").first<{ status: string; job_id: string }>();
    expect(row).toEqual({ status: 'running', job_id: 'job_x' });
    const again = (await (await call('/api/ingest/audit/queue', { headers: auth })).json()) as { items: unknown[] };
    expect(again.items).toHaveLength(0);
  });
  it('validates the body and 404s an unknown audit', async () => {
    expect((await call('/api/ingest/audit', { method: 'POST', headers: auth, body: JSON.stringify({ status: 'completed' }) })).status).toBe(400);
    const res = await call('/api/ingest/audit', { method: 'POST', headers: auth, body: JSON.stringify({ audit_id: 'aud_missing', status: 'completed' }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Unknown audit', code: 'not_found' });
  });
  it('stores the result, completes the audit and emits audit.completed', async () => {
    const result = { summary: { claims_flagged: 2 }, red_team: { total: 10, caught: 10 } };
    const res = await call('/api/ingest/audit', { method: 'POST', headers: auth, body: JSON.stringify({ audit_id: 'aud_t1', status: 'completed', job_id: 'job_x', result }) });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, result_json, completed_at FROM audits WHERE id='aud_t1'").first<{ status: string; result_json: string; completed_at: string }>();
    expect(row?.status).toBe('completed');
    expect(JSON.parse(row!.result_json)).toEqual(result);
    expect(row?.completed_at).toBeTruthy();
    const ev = await env.DB.prepare("SELECT payload_json FROM events WHERE type='audit.completed' ORDER BY at DESC LIMIT 1").first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json)).toMatchObject({ audit_id: 'aud_t1', status: 'completed' });
    expect(JSON.parse((await env.CACHE.get('audit:red_team:latest'))!).red_team).toEqual(result.red_team);
  });
});
