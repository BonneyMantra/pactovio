import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { signComposioWebhook } from '@pactovio/connectors';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
let cookie = '';
const started: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, init: RequestInit = {}, e: Env = env) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } }), e, ctx);
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, INTAKE: { create: async (o: Record<string, unknown>) => { started.push(o); return {} as never; } } as never } as Env;
  cookie = (await call('/api/health')).headers.get('set-cookie')?.split(';')[0] ?? '';
  cookie = (await call('/api/session')).headers.get('set-cookie')?.split(';')[0] ?? cookie;
}, 60_000);
afterAll(async () => dispose?.());

describe('connectors API', () => {
  it('GET /api/connectors lists exactly the 15 providers with contract-valid items', async () => {
    const res = await call('/api/connectors');
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { provider: string; status: string; rules: unknown[] }[] };
    expect(items).toHaveLength(15);
    expect(items.find((i) => i.provider === 'microsoft_teams')!.status).toBe('needs_work_account');
    expect(items.every((i) => Array.isArray(i.rules))).toBe(true);
  });

  it('rejects unknown providers and unknown actions, and reports a provider that is not connected without throwing', async () => {
    expect((await call('/api/connectors/nope/connect', json({}))).status).toBe(404);
    expect((await call('/api/connectors/slack/test', json({ action: 'delete_workspace' }))).status).toBe(400);
    const res = await call('/api/connectors/hubspot/test', json({ action: 'create_deal', input: { name: 'x' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, output: { error: 'hubspot is not connected', code: 'not_connected' } });
  });

  it('PATCH /rules stores workspace overrides and the catalogue reflects them; unknown actions are rejected', async () => {
    const bad = await call('/api/connectors/hubspot/rules', { ...json({ rules: [{ event: 'verdict.ready', action: 'nuke', enabled: true }] }), method: 'PATCH' });
    expect(bad.status).toBe(400);
    const ok = await call('/api/connectors/hubspot/rules', { ...json({ rules: [{ event: 'verdict.ready', action: 'sync_bid', enabled: false }] }), method: 'PATCH' });
    expect(ok.status).toBe(200);
    const items = ((await (await call('/api/connectors')).json()) as { items: { provider: string; rules: { enabled: boolean }[] }[] }).items;
    expect(items.find((i) => i.provider === 'hubspot')!.rules[0]!.enabled).toBe(false);
  });

  it('the public demo cannot disconnect or replace a live shared connection', async () => {
    await env.DB.prepare("INSERT INTO connectors (id, workspace_id, provider, status, external_account_id, meta_json, connected_at) VALUES ('cnx_live', 'ws_harbour_digital', 'dropbox', 'connected', 'ca_x', '{}', '2026-10-30T00:00:00Z')").run();
    const prod = { ...env, ENVIRONMENT: 'production' } as Env;
    expect((await call('/api/connectors/dropbox/disconnect', json({}), prod)).status).toBe(403);
    expect((await call('/api/connectors/dropbox/connect', json({}), prod)).status).toBe(403);
  });

  it('GET /api/connectors/callback sends the browser back with status=failed for an unknown connection attempt', async () => {
    const res = await call('/api/connectors/callback?w=ws_harbour_digital&p=slack&status=success&connected_account_id=ca_forged');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?connector=slack&status=failed');
  });
});

describe('intakes API', () => {
  it('POST /api/intakes with pasted text opens an intake and starts IntakeWorkflow with the chosen door', async () => {
    const res = await call('/api/intakes', json({ title: 'Westbay fog monitoring', sender: 'ciaran.doyle@westbay-port.example', text: 'Six stations, RS-485 Modbus, 4G backhaul.', door: 'design' }));
    expect(res.status).toBe(200);
    const { intake_id } = (await res.json()) as { intake_id: string };
    expect(started.at(-1)).toMatchObject({ id: intake_id, params: { intakeId: intake_id, source: 'upload', forceDoor: 'design', prestored: { subject: 'Westbay fog monitoring' } } });
    const docs = await env.DB.prepare('SELECT kind FROM documents WHERE intake_id = ?').bind(intake_id).all<{ kind: string }>();
    expect(docs.results.map((d) => d.kind)).toEqual(['email']);
  });

  it('POST /api/intakes/upload stores PDFs and rejects unsupported files and empty submissions', async () => {
    const form = new FormData();
    form.append('file', new File(['%PDF-1.4 rfp'], 'RFP-CCC-2026-14.pdf', { type: 'application/pdf' }));
    form.append('title', 'RFP CCC-2026-14');
    const res = await call('/api/intakes/upload', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const { intake_id } = (await res.json()) as { intake_id: string };
    const docs = await env.DB.prepare('SELECT filename, kind FROM documents WHERE intake_id = ? ORDER BY filename').bind(intake_id).all<{ filename: string; kind: string }>();
    expect(docs.results).toEqual([{ filename: 'RFP-CCC-2026-14.pdf', kind: 'pdf' }, { filename: 'message.txt', kind: 'email' }]);
    const exe = new FormData(); exe.append('file', new File(['MZ'], 'setup.exe'));
    expect((await call('/api/intakes/upload', { method: 'POST', body: exe })).status).toBe(400);
    expect((await call('/api/intakes', json({}))).status).toBe(400);
  });

  it('/v1 intakes require an API key', async () => {
    expect((await call('/v1/intakes/upload', { method: 'POST', body: new FormData() })).status).toBe(401);
  });
});

describe('POST /webhooks/composio', () => {
  it('is wired to the verifier: 503 without a secret, 401 for a bad signature, 200 for a signed trigger nobody owns', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'composio.trigger.message', metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', connected_account_id: 'ca_nobody' }, data: { message_id: 'm1' } });
    const now = Math.floor(Date.now() / 1000);
    const headers = async (secret: string) => ({ 'webhook-id': 'msg_x', 'webhook-timestamp': String(now), 'webhook-signature': await signComposioWebhook(secret, 'msg_x', now, body) });
    expect((await call('/webhooks/composio', { method: 'POST', body, headers: await headers('s') })).status).toBe(503);
    const withSecret = { ...env, COMPOSIO_WEBHOOK_SECRET: 's3cret' } as Env;
    expect((await call('/webhooks/composio', { method: 'POST', body, headers: await headers('wrong') }, withSecret)).status).toBe(401);
    const ok = await call('/webhooks/composio', { method: 'POST', body, headers: await headers('s3cret') }, withSecret);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ignored: 'no workspace owns this mailbox' });
  });
});
