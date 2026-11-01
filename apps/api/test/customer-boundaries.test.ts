import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { runAction, saveConnector } from '@pactovio/connectors';
import { buildApp } from '../src/app';
import { invokeTool } from '../src/lib/customer-tools';
import { sha256Hex } from '../src/lib/db';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>;
let a: Awaited<ReturnType<typeof customerFixture>>, b: typeof a;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, method = 'GET', body?: unknown, cookie = a.cookie) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method, headers: { cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env, ctx);
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  a = await customerFixture(env); b = await customerFixture(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country) VALUES ('tnd_private_b', 'upload', 'private-b', 'Private equipment RFQ', 'Bay Instrumentation', 'bay-instrumentation', 'MY')"),
    env.DB.prepare("INSERT INTO intakes (id, workspace_id, door, source, title, received_at, tender_id) VALUES ('int_private_b', ?, 'rfp', 'upload', 'Private RFQ', ?, 'tnd_private_b')").bind(b.workspace, new Date().toISOString()),
    env.DB.prepare("INSERT INTO documents (id, workspace_id, tender_id, intake_id, filename, kind, r2_key) VALUES ('doc_private_b', ?, 'tnd_private_b', 'int_private_b', 'Requirements.docx', 'docx', 'private-b/requirements.docx')").bind(b.workspace),
    env.DB.prepare("INSERT INTO evidence (id, workspace_id, kind, title, r2_key) VALUES ('ev_private_b', ?, 'insurance', 'Private policy', 'private-b/policy.pdf')").bind(b.workspace),
    env.DB.prepare("INSERT INTO quotes (id, workspace_id) VALUES ('quo_private_b', ?)").bind(b.workspace),
    env.DB.prepare("INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, started_at) VALUES ('run_private_b', ?, 'tender', 'tnd_private_b', 'pack_run', ?)").bind(b.workspace, new Date().toISOString()),
    env.DB.prepare("INSERT INTO answers (id, workspace_id, tender_id, question_ref, question, status) VALUES ('ans_owned_a', ?, 'tnd_sample_teagasc_p4941', '1', 'Service scope', 'approved')").bind(a.workspace),
  ]);
}, 60000);
afterAll(async () => dispose?.());

describe('customer tenant boundaries', () => {
  it('starts empty and never lists sample or other customer data', async () => {
    for (const path of ['/evidence', '/intakes', '/quotes', '/design-requests', '/products', '/tenders']) {
      const res = await call(path); expect(res.status, path).toBe(200);
      expect((await res.json() as any).items, path).toEqual([]);
    }
    const workspaces = await (await call('/workspaces')).json() as any;
    expect(workspaces.items.map((w: any) => w.id)).toEqual([a.workspace]);
  });
  it('denies foreign private IDs for reads, writes, exports and pack execution', async () => {
    for (const path of ['/workspaces/' + b.workspace, '/evidence/ev_private_b', '/intakes/int_private_b', '/quotes/quo_private_b', '/quotes/quo_private_b/export?format=docx', '/runs/run_private_b', '/tenders/tnd_private_b', '/tenders/tnd_private_b/matrix']) {
      expect((await call(path)).status, path).toBe(404);
    }
    expect((await call('/tenders/tnd_private_b/runs', 'POST', {})).status).toBe(404);
    expect((await call('/tenders/tnd_sample_teagasc_p4941/forms/doc_private_b/fill', 'POST', {})).status).toBe(404);
    expect((await call('/tenders/tnd_sample_teagasc_p4941/forms/doc_private_b/filled')).status).toBe(404);
    expect((await call('/workspaces/switch', 'POST', { workspace_id: 'ws_harbour_digital' })).status).toBe(403);
    expect((await call('/tenders/tnd_private_b', 'GET', undefined, b.cookie)).status).toBe(200);
  });
  it('never exposes foreign private document metadata on a public tender', async () => {
    await env.DB.prepare("UPDATE documents SET tender_id = 'tnd_sample_teagasc_p4941' WHERE id = 'doc_private_b'").run();
    const res = await call('/tenders/tnd_sample_teagasc_p4941');
    expect(res.status).toBe(200);
    const docs = (await res.json() as any).documents;
    expect(docs.some((d: any) => d.id === 'doc_private_b')).toBe(false);
    expect(docs.every((d: any) => d.workspace_id === null || d.workspace_id === a.workspace)).toBe(true);
    const out = await invokeTool(env, { workspaceId: a.workspace }, 'get_tender', { tender_id: 'tnd_sample_teagasc_p4941' });
    expect(out).toMatchObject({ status: 'error', code: 'not_found' });
  });
  it('guards agent reads and confirmation descriptions before they can resolve foreign private IDs', async () => {
    for (const name of ['get_tender', 'get_matrix', 'get_verdicts', 'start_pack_run', 'draft_answers']) {
      const out = await invokeTool(env, { workspaceId: a.workspace }, name, { tender_id: 'tnd_private_b' });
      expect(out, name).toMatchObject({ status: 'error', code: 'not_found' });
    }
    const result = await invokeTool(env, { workspaceId: a.workspace }, 'create_quote', { design_request_id: 'dsg_sample_westbay' });
    expect(result).toMatchObject({ status: 'error', code: 'not_found' });
  });
  it('overwrites forged internal workspace/session headers on WebSocket forwarding', async () => {
    const previous = env.AGENT;
    let target = '', request: Request | undefined;
    env.AGENT = { idFromName: (name: string) => { target = name; return name; }, get: () => ({ fetch: async (r: Request) => {
      request = r; return Response.json({ ok: true });
    } }) } as unknown as DurableObjectNamespace;
    try {
      const res = await app.fetch(new Request(`https://pactovio.example/api/agent/ws?workspace=${b.workspace}&session=${b.session}`, {
        headers: { cookie: a.cookie, origin: 'https://pactovio.example', upgrade: 'websocket', 'x-pv-workspace': b.workspace, 'x-pv-session': b.session },
      }), env, ctx);
      expect(res.status).toBe(200); expect(target).toBe(a.workspace);
      expect(request!.headers.get('x-pv-workspace')).toBe(a.workspace);
      expect(request!.headers.get('x-pv-session')).toBe(a.session);
      expect(new URL(request!.url).searchParams.get('workspace')).toBe(a.workspace);
    } finally { env.AGENT = previous; }
  });
  it('cannot export another tenant R2 object through its own storage connection', async () => {
    await saveConnector(env, a.workspace, 'googledrive', { status: 'connected', external_account_id: 'ca_owned_a',
      meta: { composio_user_id: `pactovio-workspace-${a.workspace}`, owner: true } });
    let calls = 0;
    const transport = (async () => { calls++; throw new Error('Unexpected provider call'); }) as typeof fetch;
    await expect(runAction(env, a.workspace, 'googledrive', 'upload_file', { r2_key: 'private-b/policy.pdf' }, { fetch: transport })).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(0);
  });
  it('rejects legacy sample API keys while preserving private customer API keys', async () => {
    const key = 'pk_sample_boundary_test';
    await env.DB.prepare("INSERT INTO api_keys (id, workspace_id, prefix, hash, name, created_at) VALUES ('key_sample_boundary', 'ws_harbour_digital', 'pk_sample', ?, 'Legacy sample key', ?)").bind(await sha256Hex(key), new Date().toISOString()).run();
    const res = await app.fetch(new Request('https://pactovio.example/v1/connectors', { headers: { authorization: `Bearer ${key}` } }), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe('resumable onboarding', () => {
  it('validates company/settings, persists drafts, and requires complete facts before completion', async () => {
    expect((await call('/onboarding/complete', 'POST', {})).status).toBe(400);
    expect((await call('/onboarding', 'PATCH', { company: { website: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await call('/onboarding', 'PATCH', { settings: { timezone: 'Nowhere/Invalid' } })).status).toBe(400);
    expect((await call('/onboarding', 'PATCH', { company: { name: 'Meridian Instruments Sdn Bhd', country: 'my' } })).status).toBe(200);
    const draft = await (await call('/onboarding')).json() as any;
    expect(draft.company).toMatchObject({ name: 'Meridian Instruments Sdn Bhd', country: 'MY' });
    expect(draft.completed_at).toBeNull();
    expect((await call('/onboarding', 'PATCH', { company: { supplier_segment: 'industrial', capabilities: ['Industrial telemetry'], website: 'https://meridian.example' }, settings: { timezone: 'Asia/Kuala_Lumpur', notifications_enabled: true } })).status).toBe(200);
    expect((await call('/onboarding/complete', 'POST', {})).status).toBe(200);
    const session = await (await call('/session')).json() as any;
    expect(session.onboarding_complete).toBe(true);
    expect(session.workspace.profile).toMatchObject({ legal_name: 'Meridian Instruments Sdn Bhd', hq: { country: 'MY' }, capabilities: ['Industrial telemetry'] });
    expect(session.workspace.profile.certifications).toEqual([]);
    expect((await (await call('/onboarding', 'GET', undefined, b.cookie)).json() as any).company).toEqual({});
    expect((await call('/onboarding', 'PATCH', { workspace_id: b.workspace, company: { name: 'Overwrite' } })).status).toBe(400);
  });
  it('mints private keys without granting workspace selection through IDs', async () => {
    const created = await call('/api-keys', 'POST', { name: 'Meridian automation' });
    expect(created.status).toBe(200);
    const k = await created.json() as any;
    const res = await app.fetch(new Request(`https://pactovio.example/v1/workspaces/${b.workspace}`, { headers: { authorization: `Bearer ${k.key}` } }), env, ctx);
    expect(res.status).toBe(404);
  });
});
