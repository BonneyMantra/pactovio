import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { getConnector, handleComposioWebhook, saveConnector, signComposioWebhook } from '../src';
import { makeEnv } from '../../../apps/api/test/helpers';

const SECRET = 'whsec-unit-test';
let env: Env;
let dispose: () => Promise<void>;
const started: { id: string; params: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOW = 1_761_800_000;
let seq = 0;

async function deliver(body: Record<string, unknown>, over: { id?: string; sig?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const id = over.id ?? `msg_wh${++seq}`;
  const ts = over.ts ?? NOW;
  const h = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': over.sig ?? (await signComposioWebhook(SECRET, id, ts, raw)) };
  return handleComposioWebhook(env, raw, { get: (n) => h[n.toLowerCase() as keyof typeof h] ?? null }, NOW);
}
const gmailEvent = (over: Record<string, unknown> = {}) => ({
  id: `evt_${++seq}`, type: 'composio.trigger.message', timestamp: '2026-10-30T05:00:00Z',
  metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: 'ti_gmail', connected_account_id: 'ca_gmail', user_id: 'pactovio-demo' },
  data: { message_id: `18c2f${seq}`, thread_id: 't-1', sender: 'Ciarán Doyle <ciaran.doyle@westbay-port.example>', subject: 'Fog monitoring for the Berth 4 to 9 approach: can you design and quote?', message_text: 'Six monitoring stations ...', message_timestamp: '2026-10-30T05:00:00Z', ...over },
});

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, COMPOSIO_WEBHOOK_SECRET: SECRET, INTAKE: { create: async (o: { id: string; params: Record<string, unknown> }) => { started.push(o as never); return {} as never; } } as never } as Env;
  const live = { status: 'connected' as const, external_account_id: 'ca_gmail', connected_at: '2026-10-30T00:00:00Z' };
  await saveConnector(env, 'ws_harbour_digital', 'gmail', { ...live, meta: { config: { trigger: { id: 'ti_other' } } } });
  await saveConnector(env, 'ws_kestrel_sensing', 'gmail', { ...live, meta: { config: { trigger: { id: 'ti_gmail' } } } });
}, 60_000);
afterAll(async () => dispose?.());

describe('POST /webhooks/composio', () => {
  it('rejects a bad signature, a stale timestamp and a missing secret before touching anything', async () => {
    const before = started.length;
    expect((await deliver(gmailEvent(), { sig: 'v1,AAAA' })).status).toBe(401);
    expect((await deliver(gmailEvent(), { ts: NOW - 1000 })).status).toBe(401);
    const saved = env.COMPOSIO_WEBHOOK_SECRET;
    env = { ...env, COMPOSIO_WEBHOOK_SECRET: undefined } as Env;
    expect((await deliver(gmailEvent())).status).toBe(503);
    env = { ...env, COMPOSIO_WEBHOOK_SECRET: saved } as Env;
    expect(started.length).toBe(before);
  });

  it('opens an intake in the workspace that owns the trigger and starts IntakeWorkflow with the shared-mailbox candidates', async () => {
    const r = await deliver(gmailEvent());
    expect(r.status).toBe(200);
    const intakeId = r.body.intake_id as string;
    const row = await env.DB.prepare('SELECT * FROM intakes WHERE id = ?').bind(intakeId).first<Record<string, string>>();
    expect(row).toMatchObject({ workspace_id: 'ws_kestrel_sensing', source: 'gmail', status: 'new', sender: 'Ciarán Doyle <ciaran.doyle@westbay-port.example>' });
    const wf = started.at(-1)!;
    expect(wf.id).toBe(intakeId);
    expect(wf.params).toMatchObject({ intakeId, provider: 'gmail', workspaceId: 'ws_kestrel_sensing', candidates: ['ws_harbour_digital', 'ws_kestrel_sensing'] });
    expect(wf.params.messageId).toMatch(/^18c2f/);
    const ev = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'intake.received' AND workspace_id = 'ws_kestrel_sensing' ORDER BY at DESC LIMIT 1").first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json)).toMatchObject({ intake_id: intakeId, source: 'gmail' });
  });

  it('dedupes a redelivered webhook and a message that arrives twice under different webhook ids', async () => {
    const body = gmailEvent({ message_id: 'dup-message-1' });
    const first = await deliver(body, { id: 'msg_dupe' });
    const n = started.length;
    expect((await deliver(body, { id: 'msg_dupe' })).body).toMatchObject({ duplicate: true });
    expect((await deliver(gmailEvent({ message_id: 'dup-message-1' }))).body).toMatchObject({ duplicate: true });
    expect(first.body.intake_id).toBeTruthy();
    expect(started.length).toBe(n);
  });

  it('ignores other triggers and unknown mailboxes with 200 so Composio does not retry', async () => {
    const other = gmailEvent();
    (other.metadata as Record<string, unknown>).trigger_slug = 'SLACK_RECEIVE_MESSAGE';
    expect((await deliver(other)).body).toMatchObject({ ignored: 'SLACK_RECEIVE_MESSAGE' });
    const stranger = gmailEvent();
    (stranger.metadata as Record<string, unknown>).connected_account_id = 'ca_unknown';
    expect((await deliver(stranger)).body).toMatchObject({ ignored: 'no workspace owns this mailbox' });
  });

  it('turns an Outlook webhook trigger into an intake from the outlook_message hint', async () => {
    await saveConnector(env, 'ws_harbour_digital', 'outlook', { status: 'connected', external_account_id: 'ca_outlook', connected_at: '2026-10-30T00:00:00Z', meta: {} });
    const r = await deliver({
      id: 'evt_ol1', type: 'composio.trigger.message', metadata: { trigger_slug: 'OUTLOOK_MESSAGE_TRIGGER', trigger_id: 'ti_ol', connected_account_id: 'ca_outlook', user_id: 'pactovio-demo' },
      data: { id: 'AAMkAD-ol-1', event_type: 'created', outlook_message: { subject: 'Request for Proposals: Planning enforcement case management', from: { emailAddress: { address: 'procurement@corran-cc.example' } }, bodyPreview: 'invites proposals', receivedDateTime: '2026-10-26T10:30:00Z' } },
    });
    const row = await env.DB.prepare('SELECT * FROM intakes WHERE id = ?').bind(r.body.intake_id).first<Record<string, string>>();
    expect(row).toMatchObject({ workspace_id: 'ws_harbour_digital', source: 'outlook', title: 'Request for Proposals: Planning enforcement case management', received_at: '2026-10-26T10:30:00Z' });
  });

  it('flags the connector when Composio reports the connection expired', async () => {
    const r = await deliver({ id: 'evt_exp', type: 'composio.connected_account.expired', metadata: { connected_account_id: 'ca_outlook' }, data: {} });
    expect(r.body).toMatchObject({ handled: 'connection_expired' });
    expect(await getConnector(env, 'ws_harbour_digital', 'outlook')).toMatchObject({ status: 'error' });
  });

  it('answers 502 and marks the intake ignored when the workflow cannot start', async () => {
    const saved = env.INTAKE;
    env = { ...env, INTAKE: { create: async () => { throw new Error('workflow binding down'); } } as never } as Env;
    const r = await deliver(gmailEvent());
    env = { ...env, INTAKE: saved } as Env;
    expect(r.status).toBe(502);
    const row = await env.DB.prepare("SELECT status FROM intakes WHERE source = 'gmail' ORDER BY rowid DESC LIMIT 1").first<{ status: string }>();
    expect(row!.status).toBe('ignored');
  });
});
