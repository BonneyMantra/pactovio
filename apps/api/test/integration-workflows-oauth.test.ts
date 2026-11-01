import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, metadata, providerTransport } from '../../../packages/integrations/test/fixture';
import { workspaceUser } from '../src/lib/integration-connections';
import { sha256Hex } from '../src/lib/db';
let f: Awaited<ReturnType<typeof fixture>>;
let next = 0, config = true, toolkit = 'hubspot', scheme = 'OAUTH2', managed = true, shared = false;
const accounts = new Map<string, any>();
const links: { account: string; state: string; callback: string; user: string }[] = [];
beforeAll(async () => { f = await fixture(); }, 60000);
afterEach(() => { vi.restoreAllMocks(); accounts.clear(); links.length = 0; config = true; toolkit = 'hubspot'; scheme = 'OAUTH2'; managed = true; shared = false; });
afterAll(async () => f.dispose());
function transport(hooks: { complete?: (body: any) => unknown | Promise<unknown>; account?: (id: string) => unknown | Promise<unknown>; link?: () => Promise<void> } = {}) {
  return providerTransport(async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/toolkits/')) return { ...metadata(path.split('/').at(-1)!), auth_schemes: [scheme], composio_managed_auth_schemes: managed ? [scheme] : [] };
    if (path === '/auth_configs') return { items: config ? [{ id: 'ac-existing', toolkit: { slug: toolkit }, status: 'ENABLED', auth_scheme: scheme, is_composio_managed: managed, ...(shared ? { shared_credentials: { api_key: 'must-not-copy' } } : {}), credentials: ['OAUTH1', 'OAUTH2'].includes(scheme) ? { secret: 'must-not-leak' } : {} }] : [], next_cursor: null };
    if (path === '/connected_accounts/link') {
      await hooks.link?.();
      const account = `ca_owned_${++next}`, url = new URL(body.callback_url), state = url.searchParams.get('state')!;
      const link = { account, state, callback: body.callback_url, user: body.user_id }; links.push(link);
      accounts.set(account, { id: account, toolkit: { slug: toolkit }, user_id: body.user_id, status: 'ACTIVE', state: { val: { access_token: 'must-not-leak' } } });
      return { connected_account_id: account, redirect_url: 'https://connect.composio.dev/owned-link', expires_at: new Date(Date.now() + 600000).toISOString() };
    }
    if (path === '/connected_accounts/complete_auth') {
      if (hooks.complete) return hooks.complete(body);
      return { connected_account_id: body.session_uri, toolkit_slug: toolkit };
    }
    if (path.startsWith('/connected_accounts/')) {
      const id = path.split('/').at(-1)!;
      if (method === 'DELETE') { accounts.delete(id); return {}; }
      return hooks.account ? hooks.account(id) : accounts.get(id) ?? new Response('{}', { status: 404 });
    }
    throw new Error(`Unexpected provider operation ${method} ${path}`);
  });
}
async function start(slug: string = toolkit) {
  const res = await f.call(`/toolkits/${slug}/connect`, { return_path: '/app#/onboarding' });
  expect(res.status).toBe(200); return { ...(await res.json() as any), link: links.at(-1)!, cookie: res.headers.get('set-cookie')! };
}
async function callback(link: typeof links[number], options: { cookie?: string; state?: string; uri?: string } = {}) {
  const cookie = `${options.cookie ?? f.owner.cookie}; pv_integration_oauth=${link.state}`;
  return f.call(`/verifier?state=${options.state ?? link.state}&session_uri=${options.uri ?? link.account}`, undefined, { cookie });
}
describe('universal hosted OAuth lifecycle', () => {
  it('requires verified project setup and safe return paths, and never auto-creates auth configs', async () => {
    const t = transport();
    f.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED = 'false';
    const blocked = await f.call('/toolkits/hubspot/connect', {}); expect(blocked.status).toBe(409);
    f.env.COMPOSIO_CALLBACK_VERIFIER_ENABLED = 'true'; config = false;
    expect((await f.call('/toolkits/hubspot/connect', {})).status).toBe(409);
    config = true;
    for (const return_path of ['https://foreign.example', '//foreign.example', '/app#/connections?injected=1', '/api/auth/logout']) {
      expect((await f.call('/toolkits/hubspot/connect', { return_path })).status).toBe(400);
    }
    expect(t.mock.calls.some(([url, init]) => init?.method === 'POST' && String(url).includes('/auth_configs'))).toBe(false);
    expect(links).toHaveLength(0);
  });
  it('supports managed OAuth1 and existing custom hosted API-key configs without handling credentials', async () => {
    const t = transport(); scheme = 'OAUTH1'; toolkit = 'twitter';
    const oauth = await start(); expect((await callback(oauth.link)).headers.get('location')).toContain('success');
    scheme = 'API_KEY'; managed = false; toolkit = 'airtable';
    const hosted = await start();
    const before = t.mock.calls.filter(([url]) => String(url).endsWith('/complete_auth')).length;
    const callbackResult = await f.call(`/verifier?state=${hosted.link.state}`, undefined,
      { cookie: `${f.owner.cookie}; pv_integration_oauth=${hosted.link.state}` });
    expect(callbackResult.headers.get('location')).toContain('success');
    expect(t.mock.calls.filter(([url]) => String(url).endsWith('/complete_auth'))).toHaveLength(before);
    expect(JSON.stringify(await f.env.DB.prepare('SELECT * FROM integration_connections WHERE id=?').bind(hosted.connection_id).first())).not.toContain('must-not-leak');
    shared = true;
    expect((await f.call('/toolkits/airtable/connect', {})).status).toBe(409);
    expect((await f.call('/toolkits/airtable/connect', { api_key: 'not-accepted' })).status).toBe(400);
  });
  it('uses a server-derived workspace identity, hashed expiring state and a credential-free response', async () => {
    transport(); const result = await start();
    expect(result.link.user).toBe(workspaceUser(f.owner.workspace));
    expect(result.link.callback).toContain('/api/integrations/workflows/verifier?state=');
    expect(result.cookie).toContain('HttpOnly'); expect(result.cookie).toContain('SameSite=Lax'); expect(result.cookie).toContain('Path=/api');
    const state = await f.env.DB.prepare('SELECT * FROM integration_oauth_states WHERE state_hash=?').bind(await sha256Hex(result.link.state)).first<any>();
    expect(state).toMatchObject({ workspace_id: f.owner.workspace, session_id: f.owner.session, account_id: result.link.account, origin: 'http://localhost', consumed_at: null });
    expect(state.expires_at - Date.now()).toBeGreaterThan(590000);
    const response = JSON.stringify(result); expect(response).not.toContain('must-not-leak');
    const callbackResult = await callback(result.link); expect(callbackResult.status).toBe(302);
    expect(callbackResult.headers.get('location')).toBe('/app#/onboarding?toolkit=hubspot&status=success');
    const row = await f.env.DB.prepare('SELECT status,account_id FROM integration_connections WHERE id=?').bind(result.connection_id).first();
    expect(row).toEqual({ status: 'active', account_id: result.link.account });
    expect((await callback(result.link)).headers.get('location')).toContain('failed');
  });
  it('rejects state/cookie/session/account/toolkit forgeries and expired attempts', async () => {
    const t = transport();
    const first = await start();
    expect((await callback(first.link, { cookie: f.other.cookie })).headers.get('location')).toContain('failed');
    expect((await callback(first.link, { state: 'a'.repeat(64) })).headers.get('location')).toContain('failed');
    expect((await callback(first.link, { uri: 'ca_foreign' })).headers.get('location')).toContain('failed');
    accounts.set(first.link.account, { ...accounts.get(first.link.account), user_id: workspaceUser(f.other.workspace) });
    expect((await callback(first.link)).headers.get('location')).toContain('failed');
    accounts.set(first.link.account, { ...accounts.get(first.link.account), user_id: workspaceUser(f.owner.workspace), toolkit: { slug: 'stripe' } });
    expect((await callback(first.link)).headers.get('location')).toContain('failed');
    await f.env.DB.prepare('UPDATE integration_oauth_states SET expires_at=0 WHERE state_hash=?').bind(await sha256Hex(first.link.state)).run();
    const before = t.mock.calls.length;
    expect((await callback(first.link)).headers.get('location')).toContain('failed'); expect(t.mock.calls.length).toBe(before);
    expect(await f.env.DB.prepare('SELECT status FROM integration_connections WHERE id=?').bind(first.connection_id).first()).toEqual({ status: 'pending' });
  });
  it('preserves the newer attempt and its cookie when older callbacks arrive', async () => {
    transport(); const older = await start(), newer = await start();
    expect((await callback(older.link)).headers.get('location')).toContain('failed');
    const crossed = await callback(newer.link, { uri: older.link.account });
    expect(crossed.headers.get('location')).toContain('failed'); expect(crossed.headers.get('set-cookie')).toBeNull();
    expect((await callback(newer.link)).headers.get('location')).toContain('success');
    expect(await f.env.DB.prepare('SELECT account_id,status FROM integration_connections WHERE id=?').bind(newer.connection_id).first()).toEqual({ account_id: newer.link.account, status: 'active' });
  });
  it('preserves the newer link when an older initiation finishes late and retains its owned cleanup pointer', async () => {
    let unblock!: () => void, entered!: () => void, first = true;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const delay = new Promise<void>(resolve => { unblock = resolve; });
    transport({ link: async () => { if (first) { first = false; entered(); await delay; } } });
    const older = f.call('/toolkits/hubspot/connect', {}); await waiting;
    const newer = await start(); unblock();
    expect((await older).status).toBe(409);
    expect((await callback(newer.link)).headers.get('location')).toContain('success');
    const stale = links.at(-1)!;
    expect(await f.env.DB.prepare('SELECT account_id FROM integration_oauth_states WHERE state_hash=?').bind(await sha256Hex(stale.state)).first()).toEqual({ account_id: stale.account });
  });
  it('conditionally writes the winner if an attempt supersedes it during verification', async () => {
    let unblock: (() => void) | undefined, entered: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const delay = new Promise<void>(resolve => { unblock = resolve; });
    let block = true;
    transport({ account: async id => { if (block) { entered!(); await delay; } return accounts.get(id); } });
    const older = await start(), pending = callback(older.link); await waiting;
    block = false; const newer = await start(); unblock!();
    expect((await pending).headers.get('location')).toContain('failed');
    expect((await callback(newer.link)).headers.get('location')).toContain('success');
  });
  it('checks session revocation atomically after upstream verification', async () => {
    const fresh = await (await import('./customer-fixture')).customerFixture(f.env, f.owner.workspace);
    transport({ account: async id => {
      await f.env.DB.prepare('UPDATE customer_sessions SET revoked_at=? WHERE id=?').bind(Date.now(), fresh.session).run(); return accounts.get(id);
    } });
    const res = await f.call('/toolkits/hubspot/connect', {}, { cookie: fresh.cookie }); expect(res.status).toBe(200);
    const result = await callback(links.at(-1)!, { cookie: fresh.cookie }); expect(result.headers.get('location')).toContain('failed');
  });
  it('disconnects only a locally bound and remotely verified workspace account, invalidating pending callbacks', async () => {
    const t = transport(), result = await start(); await callback(result.link);
    expect((await f.call(`/connections/${result.connection_id}/disconnect`, {}, { cookie: f.other.cookie })).status).toBe(404);
    const pending = await start();
    let disconnected = await f.call(`/connections/${pending.connection_id}/disconnect`, {});
    for (let retry = 0; disconnected.status === 503 && retry < 10; retry++) disconnected = await f.call(`/connections/${pending.connection_id}/disconnect`, {});
    expect(disconnected.status).toBe(200);
    expect((await callback(pending.link)).headers.get('location')).toContain('failed');
    expect(t.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2);
    expect(accounts.has(result.link.account)).toBe(false);
    const another = await start(); await callback(another.link);
    accounts.set(another.link.account, { ...accounts.get(another.link.account), user_id: workspaceUser(f.other.workspace) });
    const count = t.mock.calls.filter(([, init]) => init?.method === 'DELETE').length;
    expect((await f.call(`/connections/${another.connection_id}/disconnect`, {})).status).toBe(503);
    expect(t.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(count);
  });
});
