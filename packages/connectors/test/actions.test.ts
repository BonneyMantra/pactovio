import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { makeCtx, PROVIDER_ACTIONS, PROVIDERS, type ActionOutput } from '../src';
import type { ConnectorRow } from '../src/store';
import { eventWindow } from '../src/providers/calendar';
import { fakeComposio } from './fake-composio';
import { DOCUSIGN_USERINFO, RESPONSES } from './fixtures/responses';
import schemas from './fixtures/tool-schemas.json';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function check(tool: string, args: unknown): string[] {
  const schema = (schemas as Record<string, object>)[tool];
  if (!schema) return [`no live schema snapshot for ${tool}`];
  if (!validators.has(tool)) validators.set(tool, ajv.compile(schema));
  const v = validators.get(tool)!;
  return v(args) ? [] : (v.errors ?? []).map((e) => `${tool}: ${e.instancePath || '(root)'} ${e.message}`);
}

const fake = (provider: string, meta: Record<string, unknown> = {}, opts: Parameters<typeof fakeComposio>[1] = {}) => {
  const f = fakeComposio(RESPONSES, { proxy: (r) => (String(r.endpoint).endsWith('/oauth/userinfo') ? { status: 200, data: DOCUSIGN_USERINFO } : { status: 201, data: { envelopeId: 'e7a1-0001', status: 'sent' } }), ...opts });
  const row: ConnectorRow = { id: 'cnx_t', workspace_id: 'ws_t', provider, status: 'connected', external_account_id: 'ca_test', meta, connected_at: null };
  const saved: Record<string, unknown>[] = [];
  const ctx = makeCtx({ COMPOSIO_API_KEY: 'k' } as Env, row, { fetch: f.fetch, now: () => new Date('2026-10-30T10:00:00Z') }, {
    saveConfig: async (p) => { saved.push(p); row.meta.config = { ...(row.meta.config ?? {}), ...p }; },
  });
  return { ...f, ctx, saved, row };
};

/** Inputs for actions that have no `sample`. */
const INPUTS: Record<string, Record<string, Record<string, unknown>>> = {
  gmail: { get_message: { message_id: '18c2f0a1b2' } },
  outlook: { get_message: { message_id: 'AAMkAD-msg-1' } },
  hubspot: { update_deal: { deal_id: '30911234567', stage: 'bidding', amount: 5_950_000, close_date: '2026-11-19T14:00:00Z' }, add_note: { deal_id: '30911234567', body: 'Pactovio verdict: BID' } },
  salesforce: { update_opportunity: { opportunity_id: '006Hn00000AbCdEIAV', stage: 'submitted', amount: 220000, close_date: '2026-11-16' }, add_note: { opportunity_id: '006Hn00000AbCdEIAV', body: 'Pactovio verdict: BID' } },
};
const CONFIGURED: Record<string, Record<string, unknown>> = { gmail: { trigger: { id: 'ti_1' } }, outlook: { trigger: { id: 'ti_2' } } };

const cases = PROVIDERS.flatMap((p) => Object.keys(PROVIDER_ACTIONS[p.provider]!).map((action) => [`${p.provider}.${action}`, p.provider, action] as const));

describe('every provider action builds tool calls the live Composio schemas accept', () => {
  it.each(cases)('%s', async (_name, provider, action) => {
    const def = PROVIDER_ACTIONS[provider]![action]!;
    const f = fake(provider, { config: CONFIGURED[provider] });
    const input = INPUTS[provider]?.[action] ?? def.sample?.({ email: null }) ?? {};
    const out: ActionOutput = await def.run(input, f.ctx);
    const errors = f.calls.filter((c) => !c.tool.startsWith('proxy')).flatMap((c) => check(c.tool, c.args));
    expect(errors, errors.join('\n')).toEqual([]);
    if (!['watch_inbox', 'unwatch_inbox', 'update_deal', 'update_opportunity'].includes(action) && !(provider === 'outlook' && action === 'send_test_message')) {
      expect(out.id, `${provider}.${action} returned no id from its fixture response`).toBeTruthy();
    }
    if (def.readback) expect(await def.readback(out, f.ctx), 'readback').toBe(true);
    if (def.cleanup) await def.cleanup(out, f.ctx);
    const after = f.calls.filter((c) => !c.tool.startsWith('proxy')).flatMap((c) => check(c.tool, c.args));
    expect(after, after.join('\n')).toEqual([]);
  });
});

describe('provider specifics', () => {
  it('Slack posts Block Kit with link buttons for approvals and resolves the channel id once', async () => {
    const f = fake('slack');
    await PROVIDER_ACTIONS.slack!.post_message!.run({ text: '*Approval needed*', buttons: [{ label: 'Approve', url: 'https://x.example/a' }, { label: 'Decline', url: 'https://x.example/d' }] }, f.ctx);
    const post = f.called('SLACK_SEND_MESSAGE')[0]!;
    expect(post.args.channel).toBe('C07PACTOV1');
    expect(post.args.blocks[1].elements.map((e: { url: string }) => e.url)).toEqual(['https://x.example/a', 'https://x.example/d']);
    expect(f.saved).toContainEqual({ channel: 'C07PACTOV1' });
  });

  it('Gmail replies in the thread with an empty subject, and tests only send to the mailbox itself', async () => {
    const f = fake('gmail');
    await PROVIDER_ACTIONS.gmail!.create_draft!.run({ to: 'buyer@x.example', body: 'Hi', thread_id: 't-1', subject: 'Re: x' }, f.ctx);
    expect(f.called('GMAIL_CREATE_EMAIL_DRAFT')[0]!.args).not.toHaveProperty('subject');
    await expect(PROVIDER_ACTIONS.gmail!.send_test_message!.run({ to: 'someone.else@x.example', subject: 's', body: 'b' }, f.ctx)).rejects.toThrow(/only sends to the connected mailbox/);
    expect(f.called('GMAIL_SEND_EMAIL')).toHaveLength(0);
  });

  it('Outlook drafts a reply when given a message id and never calls a send tool', async () => {
    const f = fake('outlook');
    await PROVIDER_ACTIONS.outlook!.create_draft!.run({ to: 'b@x.example', body: 'Thanks', message_id: 'AAMkAD-msg-1' }, f.ctx);
    expect(f.calls.map((c) => c.tool)).toEqual(['OUTLOOK_CREATE_DRAFT_REPLY']);
  });

  it('HubSpot maps bid stages onto the account pipeline and associates the note with the deal', async () => {
    const f = fake('hubspot');
    await PROVIDER_ACTIONS.hubspot!.create_deal!.run({ name: 'Teagasc web apps', amount: 5_950_000, close_date: '2026-11-19T14:00:00Z', stage: 'bidding' }, f.ctx);
    expect(f.called('HUBSPOT_CREATE_DEAL')[0]!.args).toMatchObject({ pipeline: 'default', dealstage: 'presentationscheduled', amount: '5950000.00', closedate: '2026-11-19' });
    await PROVIDER_ACTIONS.hubspot!.add_note!.run({ deal_id: '30911234567', body: 'BID' }, f.ctx);
    expect(f.called('HUBSPOT_CREATE_NOTE')[0]!.args.associations[0]).toEqual({ to: { id: '30911234567' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] });
  });

  it('Salesforce maps stages to the standard picklist', async () => {
    const f = fake('salesforce');
    await PROVIDER_ACTIONS.salesforce!.create_opportunity!.run({ name: 'x', close_date: '2026-11-16', stage: 'lost' }, f.ctx);
    expect(f.called('SALESFORCE_CREATE_OPPORTUNITY')[0]!.args.stage_name).toBe('Closed Lost');
  });

  it('Drive and Dropbox stage the bytes with Composio and pass the s3 reference', async () => {
    const d = fake('googledrive');
    const bytes = new TextEncoder().encode('quote');
    await PROVIDER_ACTIONS.googledrive!.upload_file!.run({ filename: 'q.csv' }, { ...d.ctx, file: { filename: 'q.csv', mimetype: 'text/csv', bytes } });
    expect(d.called('GOOGLEDRIVE_UPLOAD_FILE')[0]!.args).toMatchObject({ file_to_upload: { name: 'q.csv', mimetype: 'text/csv', s3key: expect.stringContaining('q.csv') }, folder_to_upload_to: '1FolderPactovio' });
    expect(d.staged).toEqual([{ filename: '/q.csv', bytes: 5 }]);
    const x = fake('dropbox');
    await PROVIDER_ACTIONS.dropbox!.upload_file!.run({ filename: 'p.docx', text: 'x' }, x.ctx);
    expect(x.called('DROPBOX_UPLOAD_FILE')[0]!.args.path).toBe('/Pactovio/p.docx');
  });

  it('calendar events: all-day ends the next day (exclusive), timed events last 30 minutes in UTC', async () => {
    expect(eventWindow({ start: '2026-11-19' })).toMatchObject({ allDay: true });
    const g = fake('googlecalendar');
    await PROVIDER_ACTIONS.googlecalendar!.create_event!.run({ title: 'Closes', start: '2026-11-19T14:00:00Z' }, g.ctx);
    expect(g.called('GOOGLECALENDAR_CREATE_EVENT')[0]!.args).toMatchObject({ start_datetime: '2026-11-19T14:00:00', end_datetime: '2026-11-19T14:30:00', timezone: 'UTC', create_meeting_room: false });
    const g2 = fake('googlecalendar');
    await PROVIDER_ACTIONS.googlecalendar!.create_event!.run({ title: 'Clarifications', start: '2026-11-05', all_day: true }, g2.ctx);
    expect(g2.called('GOOGLECALENDAR_CREATE_EVENT')[0]!.args).toMatchObject({ start_date: '2026-11-05', end_date: '2026-11-06' });
    const o = fake('outlook_calendar');
    await PROVIDER_ACTIONS.outlook_calendar!.create_event!.run({ title: 'Clarifications', start: '2026-11-05' }, o.ctx);
    expect(o.called('OUTLOOK_CALENDAR_CREATE_EVENT')[0]!.args).toMatchObject({ is_all_day: true, start_datetime: '2026-11-05T00:00:00', end_datetime: '2026-11-06T00:00:00' });
  });

  it('Jira and Asana create assigned, dated tasks and remember project and workspace', async () => {
    const j = fake('jira');
    await PROVIDER_ACTIONS.jira!.create_task!.run({ title: '[GAP] 4.2 ISO 14001', due_date: '2026-11-16', labels: ['pactovio', 'needs evidence'] }, j.ctx);
    expect(j.called('JIRA_CREATE_ISSUE')[0]!.args).toMatchObject({ project_key: 'PAC', issue_type: 'Task', due_date: '2026-11-16', assignee: '712020:4c0007e1-3330-434a-8522-653bb3730e6b', labels: ['pactovio', 'needs-evidence'] });
    const a = fake('asana');
    await PROVIDER_ACTIONS.asana!.create_task!.run({ title: 'x', due_date: '2026-11-16' }, a.ctx);
    expect(a.called('ASANA_CREATE_A_TASK')[0]!.args.data).toMatchObject({ workspace: '1205550001', assignee: 'me', due_on: '2026-11-16' });
  });

  it('DocuSign sends only to the connected account owner and reads the account once', async () => {
    const f = fake('docusign');
    const out = await PROVIDER_ACTIONS.docusign!.send_for_signature!.run({ subject: 'Quote', text: 'Total EUR 10' }, f.ctx);
    const env = f.calls.find((c) => c.tool.startsWith('proxy POST'))!;
    expect(env.args.endpoint).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acc-1234/envelopes');
    expect(env.args.body.recipients.signers[0].email).toBe('bonneymantra.demo@example.org');
    expect(out.id).toBe('e7a1-0001');
    await expect(PROVIDER_ACTIONS.docusign!.send_for_signature!.run({ subject: 'Quote', text: 't', signer_email: 'stranger@x.example' }, fake('docusign').ctx)).rejects.toThrow(/connected account owner/);
  });

  it('QuickBooks and Xero convert minor units to major and create the customer first', async () => {
    const input = { customer: { name: 'Westbay Port Authority', email: 'ops@westbay-port.example' }, currency: 'EUR', reference: 'quo_1', valid_until: '2026-12-01', lines: [{ description: 'Sensor', qty: 2, unit_price_minor: 184_000 }] };
    const q = fake('quickbooks');
    await PROVIDER_ACTIONS.quickbooks!.create_estimate!.run(input, q.ctx);
    expect(q.calls.map((c) => c.tool)).toEqual(['QUICKBOOKS_QUERY_CUSTOMERS', 'QUICKBOOKS_CREATE_CUSTOMER', 'QUICKBOOKS_QUERY_ITEMS', 'QUICKBOOKS_CREATE_ESTIMATE']);
    expect(q.called('QUICKBOOKS_CREATE_ESTIMATE')[0]!.args.lines[0]).toMatchObject({ Amount: 3680, SalesItemLineDetail: { Qty: 2, UnitPrice: 1840, ItemRef: { value: '1' } } });
    const x = fake('xero');
    await PROVIDER_ACTIONS.xero!.create_estimate!.run(input, x.ctx);
    expect(x.called('XERO_CREATE_QUOTE')[0]!.args).toMatchObject({ ContactID: 'c0ffee00-1111', Status: 'DRAFT', ExpiryDate: '2026-12-01', LineItems: [{ Quantity: 2, UnitAmount: 1840 }] });
  });

  it('a failed tool surfaces its error text', async () => {
    const f = fake('slack', {}, { failTools: { SLACK_SEND_MESSAGE: 'not_in_channel' } });
    await expect(PROVIDER_ACTIONS.slack!.post_message!.run({ text: 'x' }, f.ctx)).rejects.toThrow(/not_in_channel/);
  });
});
