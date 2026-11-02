import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { fakeComposio } from '../../../packages/connectors/test/fake-composio';
import { getConnector } from '@pactovio/connectors';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>, customer: Awaited<ReturnType<typeof customerFixture>>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, cookie = customer.cookie, method = 'GET') => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method, headers: { cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}),
}), env, ctx);
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, ENVIRONMENT: 'production', COMPOSIO_API_KEY: 'test-transport', COMPOSIO_CALLBACK_VERIFIER_ENABLED: 'true' };
  customer = await customerFixture(env);
}, 60000);
afterAll(async () => dispose?.());
afterEach(() => vi.unstubAllGlobals());

it('sets HttpOnly state cookie and completes the verifier callback using the authenticated customer identity', async () => {
  const account = 'ca_new_ac_slack', uid = `pactovio-workspace-${customer.workspace}`;
  const f = fakeComposio({}, { accounts: [{ id: account, toolkit: { slug: 'slack' }, user_id: uid, status: 'ACTIVE' }],
    verifiedAccount: { connected_account_id: account, toolkit_slug: 'slack' } });
  vi.stubGlobal('fetch', f.fetch);
  const started = await call('/connectors/slack/connect', customer.cookie, 'POST');
  expect(started.status).toBe(200);
  const header = started.headers.get('set-cookie')!;
  expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header).toContain('Path=/api/connectors');
  const cookies = started.headers.getSetCookie();
  expect(cookies.some(c => c.startsWith('pv_integration_oauth=;') && c.includes('Max-Age=0'))).toBe(true);
  const oauth = cookies.find(c => c.startsWith('pv_oauth='))!.split(';')[0]!;
  const returned = await call('/connectors/verifier?session_uri=opaque-provider-session', `${customer.cookie}; ${oauth}`);
  expect(returned.status).toBe(302);
  expect(returned.headers.get('location')).toBe('/app#/connections?connector=slack&status=success');
  expect(await getConnector(env, customer.workspace, 'slack')).toMatchObject({ status: 'connected', external_account_id: account });
  const repeat = await call('/connectors/verifier?session_uri=opaque-provider-session', `${customer.cookie}; ${oauth}`);
  expect(repeat.headers.get('location')).toBe('/app#/connections?status=failed');
  expect(f.log.filter((x) => x === 'POST /connected_accounts/complete_auth')).toHaveLength(1);
});

it('requires both the initiating customer session and state cookie at the verifier endpoint', async () => {
  const f = fakeComposio(); vi.stubGlobal('fetch', f.fetch);
  expect((await call('/connectors/verifier?session_uri=forged', '')).status).toBe(401);
  const noCookie = await call('/connectors/verifier?session_uri=forged');
  expect(noCookie.headers.get('location')).toBe('/app#/connections?status=failed');
  expect(f.log).toEqual([]);
});
