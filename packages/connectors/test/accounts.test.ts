import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { buildCatalog, completeCallback, connectUrl, disconnectProvider, getConnector, saveConnector, syncConnectors } from '../src';
import { makeEnv } from '../../../apps/api/test/helpers';
import { customerFixture } from '../../../apps/api/test/customer-fixture';
import { stateToken } from '../src/identity';
import { fakeComposio } from './fake-composio';

let env: Env;
let dispose: () => Promise<void>;
const W = 'ws_harbour_digital';
const R = 'ws_customer_connections';
const UID = `pactovio-workspace-${R}`;
let session: string;
let otherSession: string;
const acct = (id: string, toolkit: string, status = 'ACTIVE', user = 'pactovio-demo') => ({ id, toolkit: { slug: toolkit }, status, user_id: user, created_at: '2026-10-30T00:00:00Z', state: { val: { displayName: `${toolkit} demo account` } } });

beforeAll(async () => { ({ env, dispose } = await makeEnv()); env = { ...env, COMPOSIO_API_KEY: 'k' } as Env; session = (await customerFixture(env, R)).session; otherSession = (await customerFixture(env)).session; }, 60_000);
afterAll(async () => dispose?.());

describe('catalogue status', () => {
  it('seeded sample connections are not live; Teams reads needs_work_account; DocuSign and Xero explain the OAuth app they need', async () => {
    const items = await buildCatalog(env, W);
    expect(items).toHaveLength(15);
    const by = Object.fromEntries(items.map((i) => [i.provider, i]));
    expect(by.slack!.status).toBe('available'); // the seed row is a sample, not a Composio account
    expect(by.microsoft_teams).toMatchObject({ status: 'needs_work_account' });
    expect(by.microsoft_teams!.setup_note).toMatch(/work or school/);
    expect(by.docusign).toMatchObject({ status: 'available', managed_auth: false });
    expect(by.docusign!.setup_note).toContain('client_id');
    expect(by.xero!.setup_note).toContain('client_secret');
    expect(by.gmail).toMatchObject({ status: 'available', toolkit: 'gmail', managed_auth: true, setup_note: null });
    expect(by.hubspot!.rules).toEqual([expect.objectContaining({ event: 'verdict.ready', action: 'sync_bid', enabled: true })]);
  });
});

describe('customer connect flow', () => {
  const start = async (provider = 'slack', extra: { redirectTo?: string } = {}) => {
    const state = stateToken(), f = fakeComposio();
    const url = await connectUrl(env, R, provider, { origin: 'https://pactovio.pages.dev', sessionId: session, state, ...extra }, { fetch: f.fetch });
    return { state, f, url, account: `ca_new_ac_${provider}` };
  };
  it('uses a stable private workspace identity and stores expiring hashed state bound to the customer session', async () => {
    const { url, f, state } = await start('slack', { redirectTo: '/app#/onboarding' });
    expect(url).toBe('https://connect.composio.dev/link/lk_1');
    expect(f.log).toEqual(['GET /auth_configs', 'POST /auth_configs', 'POST /connected_accounts/link']);
    expect(await getConnector(env, R, 'slack')).toMatchObject({ status: 'pending', meta: { composio_user_id: UID, pending: { redirect_to: '/app#/onboarding' } } });
    const saved = await env.DB.prepare('SELECT * FROM connector_oauth_states WHERE workspace_id = ?').bind(R).first<any>();
    expect(saved.state_hash).not.toBe(state); expect(saved.session_id).toBe(session);
    expect(saved.expires_at - Date.now()).toBeGreaterThan(590000);
  });
  it('refuses anonymous/sample connect flows and reports own-app setup needs without provider calls', async () => {
    await expect(connectUrl(env, W, 'slack', { sessionId: session })).rejects.toMatchObject({ status: 403 });
    await expect(connectUrl(env, R, 'slack')).rejects.toMatchObject({ status: 403 });
    await expect(connectUrl(env, R, 'docusign', { sessionId: session }, { fetch: fakeComposio().fetch })).rejects.toMatchObject({ status: 409, code: 'needs_setup' });
    await expect(connectUrl(env, R, 'nope')).rejects.toMatchObject({ status: 404 });
  });
  it('rejects forged state and another session, then accepts ACTIVE matching account exactly once', async () => {
    const { state, account } = await start();
    const f = fakeComposio({}, { accounts: [acct(account, 'slack', 'ACTIVE', UID)] });
    expect((await completeCallback(env, { state: stateToken(), connected_account_id: account }, { fetch: f.fetch }, session)).ok).toBe(false);
    expect((await completeCallback(env, { state, connected_account_id: account }, { fetch: f.fetch }, otherSession)).ok).toBe(false);
    const ok = await completeCallback(env, { state, connected_account_id: account }, { fetch: f.fetch }, session);
    expect(ok).toEqual({ ok: true, redirect: '/app#/connections?connector=slack&status=success' });
    expect((await completeCallback(env, { state, connected_account_id: account }, { fetch: f.fetch }, session)).ok).toBe(false);
    expect(await getConnector(env, R, 'slack')).toMatchObject({ status: 'connected', meta: { composio_user_id: UID, owner: true } });
  });
  it.each(['inactive', 'user', 'provider', 'account'])('rejects an account %s mismatch', async (mismatch) => {
    const { state, account } = await start();
    const a = acct(account, mismatch === 'provider' ? 'gmail' : 'slack', mismatch === 'inactive' ? 'FAILED' : 'ACTIVE', mismatch === 'user' ? 'pactovio-demo' : UID);
    const result = await completeCallback(env, { state, connected_account_id: mismatch === 'account' ? 'ca_forged' : account }, { fetch: fakeComposio({}, { accounts: [a] }).fetch }, session);
    expect(result.ok).toBe(false);
    expect(await getConnector(env, R, 'slack')).toMatchObject({ status: 'error', external_account_id: null });
  });
  it('rejects expired/revoked and superseded attempts, and constrains return targets', async () => {
    const old = await start('jira', { redirectTo: 'https://evil.example/steal' });
    expect((await getConnector(env, R, 'jira'))!.meta.pending.redirect_to).toBe('/app#/connections');
    await env.DB.prepare('UPDATE connector_oauth_states SET expires_at = 0 WHERE provider = ? AND workspace_id = ?').bind('jira', R).run();
    expect((await completeCallback(env, { state: old.state }, {}, session)).ok).toBe(false);
    const superseded = await start(); await start();
    expect((await completeCallback(env, { state: superseded.state }, {}, session)).ok).toBe(false);
  });
  it('production requires the project verifier and verifies the returned session URI before activation', async () => {
    const production = { ...env, ENVIRONMENT: 'production' };
    await expect(connectUrl(production, R, 'slack', { sessionId: session }, { fetch: fakeComposio().fetch })).rejects.toMatchObject({ code: 'needs_setup' });
    const started = await start();
    const f = fakeComposio({}, { accounts: [acct(started.account, 'slack', 'ACTIVE', UID)], verifiedAccount: { connected_account_id: started.account, toolkit_slug: 'slack' } });
    const verified = { ...env, COMPOSIO_CALLBACK_VERIFIER_ENABLED: 'true' };
    const result = await completeCallback(verified, { state: started.state, session_uri: 'opaque-provider-session' }, { fetch: f.fetch }, session);
    expect(result.ok).toBe(true);
    expect(f.log).toEqual(['POST /connected_accounts/complete_auth', 'GET /connected_accounts/' + started.account]);
    const wrong = await start();
    const mismatch = fakeComposio({}, { verifiedAccount: { connected_account_id: 'ca_elsewhere', toolkit_slug: 'slack' } });
    expect((await completeCallback(verified, { state: wrong.state, session_uri: 'forged-session' }, { fetch: mismatch.fetch }, session)).ok).toBe(false);
    const noVerifier = await start();
    expect((await completeCallback(verified, { state: noVerifier.state }, { fetch: f.fetch }, session)).ok).toBe(false);
  });
  it('reports an inbox-trigger failure truthfully and retries registration on sync', async () => {
    const { state, account } = await start('gmail');
    const f = fakeComposio({}, { accounts: [acct(account, 'gmail', 'ACTIVE', UID)] });
    const failing = (async (url: RequestInfo | URL, init?: RequestInit) => String(url).includes('/trigger_instances/')
      ? Response.json({ error: { message: 'temporary failure' } }, { status: 503 }) : f.fetch(url, init)) as typeof fetch;
    expect((await completeCallback(env, { state, connected_account_id: account }, { fetch: failing }, session)).ok).toBe(true);
    expect((await buildCatalog(env, R)).find((x) => x.provider === 'gmail')).toMatchObject({ status: 'connected', setup_note: expect.stringContaining('trigger could not be registered') });
    await syncConnectors(env, R, { fetch: f.fetch }, true);
    expect((await buildCatalog(env, R)).find((x) => x.provider === 'gmail')!.setup_note).toBeNull();
    expect((await getConnector(env, R, 'gmail'))!.meta.config.trigger.id).toBeTruthy();
  });
  it('rejects a revoked starting session and never contacts Composio with that state', async () => {
    const revoked = await customerFixture(env, R), state = stateToken();
    await connectUrl(env, R, 'jira', { sessionId: revoked.session, state }, { fetch: fakeComposio().fetch });
    await env.DB.prepare('UPDATE customer_sessions SET revoked_at = ? WHERE id = ?').bind(Date.now(), revoked.session).run();
    const f = fakeComposio();
    expect((await completeCallback(env, { state }, { fetch: f.fetch }, revoked.session)).ok).toBe(false);
    expect(f.log).toEqual([]);
  });
  it('does not sync another user or a not-yet-verified connection into a customer workspace', async () => {
    const f = fakeComposio({}, { accounts: [acct('ca_demo', 'gmail'), acct('ca_unverified', 'jira', 'ACTIVE', UID)] });
    await syncConnectors(env, R, { fetch: f.fetch }, true);
    expect((await buildCatalog(env, R)).find((x) => x.provider === 'gmail')!.status).toBe('available');
    expect((await buildCatalog(env, R)).find((x) => x.provider === 'jira')!.status).not.toBe('connected');
  });
});

describe('sync and disconnect', () => {
  it('disconnecting an abandoned Connect Link removes the pending Composio account', async () => {
    const f = fakeComposio();
    await disconnectProvider(env, R, 'jira', { fetch: f.fetch }); // jira was left pending by the redirect test above
    expect(f.log).toContain('DELETE /connected_accounts/ca_new_ac_jira');
    expect(await getConnector(env, R, 'jira')).toMatchObject({ status: 'available' });
  });

  it('adopts ACTIVE Composio accounts of the demo user, shares Outlook with its calendar, and registers the mailbox trigger', async () => {
    const f = fakeComposio({}, { accounts: [acct('ca_gm', 'gmail'), acct('ca_ol', 'outlook'), acct('ca_other', 'hubspot', 'ACTIVE', 'someone-else')] });
    await syncConnectors(env, 'ws_kestrel_sensing', { fetch: f.fetch }, true);
    const items = await buildCatalog(env, 'ws_kestrel_sensing');
    const st = Object.fromEntries(items.map((i) => [i.provider, i.status]));
    expect(st).toMatchObject({ gmail: 'connected', outlook: 'connected', outlook_calendar: 'connected', hubspot: 'available' });
    expect((await getConnector(env, 'ws_kestrel_sensing', 'outlook_calendar'))!.external_account_id).toBe('ca_ol');
    expect((await getConnector(env, 'ws_kestrel_sensing', 'gmail'))!.meta.config).toMatchObject({ trigger: { id: 'ti_GMAIL_NEW_GMAIL_MESSAGE', slug: 'GMAIL_NEW_GMAIL_MESSAGE' } });
    expect(f.log).toContain('POST /trigger_instances/OUTLOOK_MESSAGE_TRIGGER/upsert');
  });

  it('an account another workspace connected itself is never shared, and a copy that was shared is detached', async () => {
    const owned = acct('ca_slack_owned', 'slack');
    await saveConnector(env, 'ws_kestrel_sensing', 'slack', { status: 'connected', external_account_id: 'ca_slack_owned', connected_at: '2026-10-30T00:00:00Z', meta: { composio_user_id: 'pactovio-demo' } });
    await saveConnector(env, W, 'slack', { status: 'connected', external_account_id: 'ca_slack_owned', connected_at: '2026-10-30T00:00:00Z', meta: { composio_user_id: 'pactovio-demo', owner: true } });
    await syncConnectors(env, 'ws_kestrel_sensing', { fetch: fakeComposio({}, { accounts: [owned] }).fetch }, true);
    expect(await getConnector(env, 'ws_kestrel_sensing', 'slack')).toMatchObject({ status: 'available', external_account_id: null });
    await syncConnectors(env, W, { fetch: fakeComposio({}, { accounts: [owned] }).fetch }, true);
    expect(await getConnector(env, W, 'slack')).toMatchObject({ status: 'connected', external_account_id: 'ca_slack_owned' });
    await saveConnector(env, W, 'slack', { status: 'available', external_account_id: null, connected_at: null, meta: { composio_user_id: 'pactovio-demo' } });
  });

  it('a Composio account that disappeared falls back to available', async () => {
    await syncConnectors(env, 'ws_kestrel_sensing', { fetch: fakeComposio({}, { accounts: [acct('ca_ol', 'outlook')] }).fetch }, true);
    const st = Object.fromEntries((await buildCatalog(env, 'ws_kestrel_sensing')).map((i) => [i.provider, i.status]));
    expect(st).toMatchObject({ gmail: 'available', outlook: 'connected' });
  });

  it('disconnect deletes the trigger but keeps the Composio account while another workspace still uses it', async () => {
    await syncConnectors(env, W, { fetch: fakeComposio({}, { accounts: [acct('ca_ol', 'outlook')] }).fetch }, true);
    const f = fakeComposio();
    await disconnectProvider(env, 'ws_kestrel_sensing', 'outlook', { fetch: f.fetch });
    expect(f.log.filter((l) => l.startsWith('DELETE /trigger_instances'))).toHaveLength(1);
    expect(f.log).not.toContain('DELETE /connected_accounts/ca_ol');
    expect(await getConnector(env, 'ws_kestrel_sensing', 'outlook_calendar')).toMatchObject({ status: 'available', external_account_id: null });
    const g = fakeComposio();
    await disconnectProvider(env, W, 'outlook', { fetch: g.fetch });
    expect(g.log).toContain('DELETE /connected_accounts/ca_ol');
  });
});
