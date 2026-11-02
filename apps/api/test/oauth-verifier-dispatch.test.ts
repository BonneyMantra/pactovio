import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { getConnector } from '@pactovio/connectors';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

/** Composio identity verification on: the browser returns to the project verifier URL with ONLY ?session_uri=. */
let env: Env, dispose: () => Promise<void>, customer: Awaited<ReturnType<typeof customerFixture>>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, cookie: string, method = 'GET', body?: unknown) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method, headers: { cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
}), env, ctx);
let scheme = 'OAUTH2', next = 0;
const accounts = new Map<string, { id: string; toolkit: { slug: string }; user_id: string; status: string }>();
const completions: { user_id: string; session_uri: string }[] = [];
function composio() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname.replace('/api/v3.1', ''), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (data: unknown, status = 200) => Response.json(data, { status });
    if (url.origin !== 'https://backend.composio.dev') throw new Error(`Unexpected request ${url.href}`);
    if (method === 'GET' && path.startsWith('/toolkits/')) {
      const slug = path.split('/').at(-1)!;
      return reply({ slug, name: slug, type: 'native', auth_schemes: [scheme], composio_managed_auth_schemes: [scheme], auth_config_details: [] });
    }
    if (method === 'GET' && path === '/auth_configs') return reply({ next_cursor: null, items: [
      { id: 'ac_hubspot', name: 'pactovio-hubspot', toolkit: { slug: 'hubspot' }, status: 'ENABLED', auth_scheme: scheme, is_composio_managed: true },
      { id: 'ac_slack', name: 'pactovio-slack', toolkit: { slug: 'slack' }, status: 'ENABLED', auth_scheme: 'OAUTH2', is_composio_managed: true }] });
    if (method === 'POST' && path === '/connected_accounts/link') {
      const toolkit = body.auth_config_id === 'ac_slack' ? 'slack' : 'hubspot', id = `ca_${toolkit}_${++next}`;
      accounts.set(id, { id, toolkit: { slug: toolkit }, user_id: body.user_id, status: 'ACTIVE' });
      return reply({ connected_account_id: id, redirect_url: `https://connect.composio.dev/link/${id}`, expires_at: new Date(Date.now() + 600000).toISOString() });
    }
    if (method === 'POST' && path === '/connected_accounts/complete_auth') {
      completions.push(body);
      const account = accounts.get(body.session_uri);
      return account && account.user_id === body.user_id ? reply({ connected_account_id: account.id, toolkit_slug: account.toolkit.slug }) : reply({ error: { message: 'bad session' } }, 400);
    }
    if (method === 'GET' && path === '/connected_accounts') return reply({ items: [], next_cursor: null });
    if (method === 'GET' && path.startsWith('/connected_accounts/')) return accounts.has(path.split('/').at(-1)!) ? reply(accounts.get(path.split('/').at(-1)!)) : reply({}, 404);
    throw new Error(`Unexpected provider operation ${method} ${path}`);
  }));
}
const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.includes('Max-Age=0'))!.split(';')[0]!;
async function startUniversal() {
  const res = await call('/integrations/workflows/toolkits/hubspot/connect', customer.cookie, 'POST', { return_path: '/app#/onboarding' });
  expect(res.status).toBe(200);
  const out = await res.json() as { connection_id: string };
  return { ...out, cookie: cookieOf(res, 'pv_integration_oauth'), account: `ca_hubspot_${next}` };
}
async function startLegacy() {
  const res = await call('/connectors/slack/connect', customer.cookie, 'POST', { redirect_to: '/app#/onboarding' });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res, 'pv_oauth'), account: `ca_slack_${next}` };
}
const connection = (id: string) => env.DB.prepare('SELECT status, account_id FROM integration_connections WHERE id = ?').bind(id).first();
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, ENVIRONMENT: 'production', COMPOSIO_API_KEY: 'transport-test-placeholder', COMPOSIO_CALLBACK_VERIFIER_ENABLED: 'true' };
}, 60000);
beforeEach(async () => { customer = await customerFixture(env); scheme = 'OAUTH2'; completions.length = 0; composio(); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => dispose?.());

describe('project verifier with session_uri only', () => {
  it('completes a universal OAuth integration from the scoped cookie and the signed-in session user', async () => {
    const started = await startUniversal();
    const back = await call(`/connectors/verifier?session_uri=${started.account}`, `${customer.cookie}; ${started.cookie}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/app#/onboarding?toolkit=hubspot&status=success');
    expect(completions).toEqual([{ user_id: `pactovio-workspace-${customer.workspace}`, session_uri: started.account }]);
    expect(await connection(started.connection_id)).toEqual({ status: 'active', account_id: started.account });
  });
  it('completes a hosted non-OAuth universal config through complete_auth when no state is returned', async () => {
    scheme = 'API_KEY';
    const started = await startUniversal();
    const back = await call(`/connectors/verifier?session_uri=${started.account}`, `${customer.cookie}; ${started.cookie}`);
    expect(back.headers.get('location')).toContain('status=success');
    expect(completions).toHaveLength(1);
  });
  it('completes a legacy connector even when an older universal cookie is still in the browser', async () => {
    const stale = await startUniversal();
    const legacy = await startLegacy();
    const back = await call(`/connectors/verifier?session_uri=${legacy.account}`, `${customer.cookie}; ${stale.cookie}; ${legacy.cookie}`);
    expect(back.headers.get('location')).toBe('/app#/onboarding?connector=slack&status=success');
    expect(await getConnector(env, customer.workspace, 'slack')).toMatchObject({ status: 'connected', external_account_id: legacy.account });
    expect(await connection(stale.connection_id)).toMatchObject({ status: 'pending' });
  });
  it('prefers the newer universal attempt over an older legacy one and rejects other sessions', async () => {
    const legacy = await startLegacy();
    await env.DB.prepare('UPDATE connector_oauth_states SET expires_at = expires_at - 60000 WHERE workspace_id = ?').bind(customer.workspace).run();
    const started = await startUniversal();
    const intruder = await customerFixture(env);
    const foreign = await call(`/connectors/verifier?session_uri=${started.account}`, `${intruder.cookie}; ${started.cookie}; ${legacy.cookie}`);
    expect(foreign.headers.get('location')).toContain('status=failed');
    expect(completions).toHaveLength(0);
    const back = await call(`/connectors/verifier?session_uri=${started.account}`, `${customer.cookie}; ${started.cookie}; ${legacy.cookie}`);
    expect(back.headers.get('location')).toBe('/app#/onboarding?toolkit=hubspot&status=success');
    expect(await call(`/connectors/verifier?session_uri=${started.account}`, '')).toHaveProperty('status', 401);
  });
});
