import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PactovioEvent } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { getConnector, runEventActions, saveConnector } from '../src';
import { makeEnv } from '../../../apps/api/test/helpers';
import { fakeComposio } from './fake-composio';
import { RESPONSES } from './fixtures/responses';

let env: Env;
let dispose: () => Promise<void>;
const HARBOUR = 'ws_harbour_digital';
const KESTREL = 'ws_kestrel_sensing';
const TEAGASC = 'tnd_sample_teagasc_p4941';
let n = 0;
const ev = (workspace_id: string, type: PactovioEvent['type'], payload: Record<string, unknown>): PactovioEvent => ({ id: `evt_t${++n}`, workspace_id, type, payload, at: '2026-10-30T10:00:00Z' });
const connect = (ws: string, provider: string, meta: Record<string, unknown> = {}) => saveConnector(env, ws, provider, { status: 'connected', external_account_id: `ca_${provider}`, connected_at: '2026-10-30T00:00:00Z', meta: { composio_user_id: 'pactovio-demo', ...meta } });

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, COMPOSIO_API_KEY: 'k' } as Env;
  for (const p of ['hubspot', 'googlecalendar', 'jira', 'slack']) await connect(HARBOUR, p);
  for (const p of ['quickbooks', 'googledrive', 'docusign']) await connect(KESTREL, p);
}, 60_000);
afterAll(async () => dispose?.());

describe('runEventActions', () => {
  it('verdict.ready: one HubSpot deal with stage, value and deadline plus a verdict note; a later event updates the same deal', async () => {
    const f = fakeComposio(RESPONSES);
    const res = await runEventActions(env, ev(HARBOUR, 'verdict.ready', { tender_id: TEAGASC }), { fetch: f.fetch });
    expect(res.filter((r) => r.provider === 'hubspot')).toEqual([expect.objectContaining({ action: 'sync_bid', ok: true, id: '30911234567' })]);
    const deal = f.called('HUBSPOT_CREATE_DEAL')[0]!.args;
    expect(deal).toMatchObject({ dealstage: 'presentationscheduled', amount: '5950000.00', closedate: '2026-11-19' });
    expect(f.called('HUBSPOT_CREATE_NOTE')[0]!.args.hs_note_body).toContain('Lot 3: CONDITIONAL');
    const again = fakeComposio(RESPONSES);
    await runEventActions(env, ev(HARBOUR, 'verdict.ready', { tender_id: TEAGASC }), { fetch: again.fetch });
    expect(again.called('HUBSPOT_CREATE_DEAL')).toHaveLength(0);
    expect(again.called('HUBSPOT_UPDATE_DEAL')[0]!.args.dealId).toBe('30911234567');
  });

  it('verdict.ready: deadline events are created once; Slack stays quiet because the agent hub mirrors chat', async () => {
    const f = fakeComposio(RESPONSES);
    const res = await runEventActions(env, ev(HARBOUR, 'verdict.ready', { tender_id: TEAGASC, decision: 'BID' }), { fetch: f.fetch });
    expect(res.some((r) => r.provider === 'slack')).toBe(false);
    expect(f.called('SLACK_SEND_MESSAGE')).toHaveLength(0);
    const again = fakeComposio(RESPONSES);
    const res2 = await runEventActions(env, ev(HARBOUR, 'verdict.ready', { tender_id: TEAGASC }), { fetch: again.fetch });
    expect(res2.find((r) => r.provider === 'googlecalendar')?.skipped).toBe('calendar events already exist');
    expect(again.called('GOOGLECALENDAR_CREATE_EVENT')).toHaveLength(0);
  });

  it('run.completed: one Jira task per GAP or NEEDS_EVIDENCE row, deduped on replay', async () => {
    const f = fakeComposio(RESPONSES);
    await runEventActions(env, ev(HARBOUR, 'run.completed', { run_id: 'run_x', tender_id: TEAGASC }), { fetch: f.fetch });
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM requirements WHERE tender_id = ? AND workspace_id = ? AND status IN ('GAP','NEEDS_EVIDENCE')").bind(TEAGASC, HARBOUR).first<{ n: number }>();
    const issues = f.called('JIRA_CREATE_ISSUE');
    expect(open!.n).toBeGreaterThan(0);
    expect(issues).toHaveLength(open!.n);
    expect(issues[0]!.args.summary).toMatch(/^\[(GAP|EVIDENCE)\]/);
    expect(issues[0]!.args.due_date).toBe('2026-11-16'); // three days before the 19 Nov deadline
    const again = fakeComposio(RESPONSES);
    const res = await runEventActions(env, ev(HARBOUR, 'run.completed', { tender_id: TEAGASC }), { fetch: again.fetch });
    expect(again.called('JIRA_CREATE_ISSUE')).toHaveLength(0);
    expect(res.find((r) => r.provider === 'jira')?.skipped).toBe('no open gaps');
  });

  it('quote.ready: quote CSV to Drive and an estimate in QuickBooks; DocuSign is opt-in', async () => {
    const f = fakeComposio(RESPONSES);
    const res = await runEventActions(env, ev(KESTREL, 'quote.ready', { quote_id: 'quo_sample_westbay' }), { fetch: f.fetch });
    expect(res.map((r) => `${r.provider}:${r.action}:${r.ok}`).sort()).toEqual(['googledrive:upload_artifacts:true', 'quickbooks:create_estimate:true']);
    expect(f.staged[0]!.filename).toBe('/quote-quo_sample_westbay.csv');
    expect(f.called('QUICKBOOKS_QUERY_CUSTOMERS')[0]!.args.query).toContain('Westbay Port Authority');
    await saveConnector(env, KESTREL, 'docusign', { meta: { ...(await getConnector(env, KESTREL, 'docusign'))!.meta, rules: [{ event: 'quote.ready', action: 'send_quote_for_signature', enabled: true }], config: { account: { accountId: 'acc-1', baseUri: 'https://demo.docusign.net', email: 'me@x.example', name: 'Me' } } } });
    const g = fakeComposio(RESPONSES, { proxy: () => ({ status: 201, data: { envelopeId: 'e1', status: 'sent' } }) });
    const res2 = await runEventActions(env, ev(KESTREL, 'quote.ready', { quote_id: 'quo_sample_westbay' }), { fetch: g.fetch });
    expect(res2.find((r) => r.provider === 'docusign')).toMatchObject({ ok: true, id: 'e1' });
  });

  it('records a failing action on the connector and still runs the others; seeded sample rows are never used', async () => {
    await saveConnector(env, HARBOUR, 'slack', { meta: { composio_user_id: 'pactovio-demo', rules: [{ event: 'certificate.expiring', action: 'post_message', enabled: true }] } });
    await saveConnector(env, HARBOUR, 'jira', { meta: { composio_user_id: 'pactovio-demo', rules: [] } });
    const f = fakeComposio(RESPONSES, { failTools: { SLACK_SEND_MESSAGE: 'not_in_channel' } });
    const res = await runEventActions(env, ev(HARBOUR, 'certificate.expiring', { title: 'ISO 27001', valid_to: '2027-03-14' }), { fetch: f.fetch });
    expect(res).toEqual([expect.objectContaining({ provider: 'slack', ok: false, error: expect.stringContaining('not_in_channel') })]);
    expect((await getConnector(env, HARBOUR, 'slack'))!.meta.last_action).toMatchObject({ ok: false, event: 'certificate.expiring' });
    await saveConnector(env, KESTREL, 'slack', { status: 'connected', external_account_id: 'sample-workspace', meta: { sample: true, rules: [{ event: 'certificate.expiring', action: 'post_message', enabled: true }] } });
    const g = fakeComposio(RESPONSES);
    expect(await runEventActions(env, ev(KESTREL, 'certificate.expiring', { title: 'x' }), { fetch: g.fetch })).toEqual([]);
    expect(g.calls).toHaveLength(0);
  });

  it('is idempotent per event id (queue retries)', async () => {
    const e = ev(KESTREL, 'quote.ready', { quote_id: 'quo_sample_westbay' });
    const f = fakeComposio(RESPONSES, { proxy: () => ({ status: 201, data: { envelopeId: 'e2' } }) });
    await runEventActions(env, e, { fetch: f.fetch });
    const g = fakeComposio(RESPONSES);
    expect(await runEventActions(env, e, { fetch: g.fetch })).toEqual([]);
    expect(g.calls).toHaveLength(0);
  });

  it('run.completed flips an emailed RFP intake from processing to ready', async () => {
    await env.DB.prepare("INSERT INTO intakes (id, workspace_id, door, source, title, received_at, status, tender_id) VALUES ('int_t_ready', ?, 'rfp', 'gmail', 'RFP', '2026-10-30T00:00:00Z', 'processing', ?)").bind(HARBOUR, TEAGASC).run();
    await runEventActions(env, ev(HARBOUR, 'run.completed', { tender_id: TEAGASC, status: 'completed' }), { fetch: fakeComposio(RESPONSES).fetch });
    expect((await env.DB.prepare("SELECT status FROM intakes WHERE id = 'int_t_ready'").first<{ status: string }>())!.status).toBe('ready');
  });
});
