import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { buildCatalog, completeCallback, connectUrl, disconnectProvider, getConnector, saveConnector, syncConnectors } from '../src';
import { makeEnv } from '../../../apps/api/test/helpers';
import { fakeComposio } from './fake-composio';

let env: Env;
let dispose: () => Promise<void>;
const W = 'ws_harbour_digital';
const acct = (id: string, toolkit: string, status = 'ACTIVE', user = 'pactovio-demo') => ({ id, toolkit: { slug: toolkit }, status, user_id: user, created_at: '2026-10-30T00:00:00Z', state: { val: { displayName: `${toolkit} demo account` } } });

beforeAll(async () => { ({ env, dispose } = await makeEnv()); env = { ...env, COMPOSIO_API_KEY: 'k' } as Env; }, 60_000);
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
    expect(by.xero!.setup_note).toContain('probity-xero');
    expect(by.gmail).toMatchObject({ status: 'available', toolkit: 'gmail', managed_auth: true, setup_note: null });
    expect(by.hubspot!.rules).toEqual([expect.objectContaining({ event: 'verdict.ready', action: 'sync_bid', enabled: true })]);
  });
});

describe('connect flow', () => {
  it('creates a pactovio-* managed auth config once, a Connect Link back to the callback, and a pending row', async () => {
    const f = fakeComposio();
    const url = await connectUrl(env, W, 'slack', { origin: 'https://pactovio.pages.dev', redirectTo: '/settings?x=1' }, { fetch: f.fetch });
    expect(url).toBe('https://connect.composio.dev/link/lk_1');
    expect(f.log).toEqual(['GET /auth_configs', 'POST /auth_configs', 'POST /connected_accounts/link']);
    const row = await getConnector(env, W, 'slack');
    expect(row).toMatchObject({ status: 'pending' });
    expect(row!.meta).toMatchObject({ composio_user_id: 'pactovio-demo', pending: { connected_account_id: 'ca_new_ac_slack', redirect_to: '/settings?x=1' } });
    expect(row!.meta.sample).toBeUndefined();
    const again = fakeComposio();
    await connectUrl(env, W, 'slack', { origin: 'https://pactovio.pages.dev' }, { fetch: again.fetch });
    expect(again.log).toEqual(['POST /connected_accounts/link']); // auth config id cached
  });

  it('refuses DocuSign without its own OAuth app and names exactly what is needed', async () => {
    const err = await connectUrl(env, W, 'docusign', {}, { fetch: fakeComposio().fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, code: 'needs_setup' });
    expect(err.message).toContain('integration key');
    await expect(connectUrl(env, W, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('callback: only the account this workspace started counts, then the row is connected and the browser goes back', async () => {
    const f = fakeComposio({}, { accounts: [acct('ca_new_ac_slack', 'slack')] });
    const forged = await completeCallback(env, { w: W, p: 'slack', status: 'success', connected_account_id: 'ca_someone_else' }, { fetch: f.fetch });
    expect(forged.ok).toBe(false);
    expect((await getConnector(env, W, 'slack'))!.status).toBe('pending');
    const ok = await completeCallback(env, { w: W, p: 'slack', status: 'success', connected_account_id: 'ca_new_ac_slack' }, { fetch: f.fetch });
    expect(ok).toEqual({ ok: true, redirect: '/?connector=slack&status=success' });
    expect(await getConnector(env, W, 'slack')).toMatchObject({ status: 'connected', external_account_id: 'ca_new_ac_slack', meta: { account_label: 'slack demo account' } });
    expect((await buildCatalog(env, W)).find((i) => i.provider === 'slack')).toMatchObject({ status: 'connected', account_label: 'slack demo account' });
  });

  it('callback: an account that is not ACTIVE marks the connector as error', async () => {
    await saveConnector(env, W, 'asana', { status: 'pending', meta: { pending: { connected_account_id: 'ca_a', redirect_to: '/' } } });
    const f = fakeComposio({}, { accounts: [acct('ca_a', 'asana', 'FAILED')] });
    expect((await completeCallback(env, { w: W, p: 'asana', connected_account_id: 'ca_a' }, { fetch: f.fetch })).ok).toBe(false);
    expect(await getConnector(env, W, 'asana')).toMatchObject({ status: 'error' });
  });

  it('does not follow an off-site redirect target', async () => {
    const f = fakeComposio();
    await connectUrl(env, W, 'jira', { origin: 'https://pactovio.pages.dev', redirectTo: 'https://evil.example/steal' }, { fetch: f.fetch });
    expect((await getConnector(env, W, 'jira'))!.meta.pending).toMatchObject({ redirect_to: '/' });
  });
});

describe('sync and disconnect', () => {
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
