import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotImplemented } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

const lane = vi.hoisted(() => ({ match: vi.fn(), run: vi.fn() }));
vi.mock('@pactovio/quote', () => ({ matchDesignRequest: lane.match }));
vi.mock('@pactovio/engine', () => ({ startPackRun: lane.run }));

import { classifyEmail, classifyStep, docKind, draftStep, fetchAndStore, heuristicClassify, routeStep, saveConnector, type InboundMessage, type IntakeJob } from '../src';
import { fetchGmail, fetchOutlook, parseGmailMessage, parseOutlookMessage } from '../src/inbound-mail';
import { makeEnv } from '../../../apps/api/test/helpers';
import { fakeComposio } from './fake-composio';
import { RESPONSES } from './fixtures/responses';

const b64u = (s: string | Uint8Array) => Buffer.from(s).toString('base64url');
const FOG = { id: 'mail_k_port_fog', from: 'Ciarán Doyle <ciaran.doyle@westbay-port.example>', subject: 'Fog monitoring for the Berth 4 to 9 approach: can you design and quote?', body: 'Six monitoring stations along Berths 4 to 9. Visibility below 500 m. RS-485 Modbus RTU output, 4G backhaul.', attachments: [], receivedAt: '2026-10-27T09:14:00Z', provider: 'gmail' as const };
const RFP: InboundMessage = { id: 'mail_h_rfp', from: 'Fionnuala Rice <procurement@corran-cc.example>', subject: 'Request for Proposals: Planning enforcement case management web application (RFP CCC-2026-14)', body: 'Corran County Council invites proposals ... by 4 December 2026, 12:00 noon.', attachments: [{ filename: 'RFP-CCC-2026-14.pdf', r2Key: 'intakes/x/0-RFP.pdf' }], receivedAt: '2026-10-26T10:30:00Z', provider: 'gmail' };

function tokenFactory(reply: object | string, seen: Record<string, any>[] = []) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (async (_u: string, init: RequestInit) => {
    seen.push(JSON.parse(init.body as string));
    const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
    return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 300, completion_tokens: 40 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('email parsing', () => {
  it('Gmail: reads headers, the plain-text part, internalDate and attachment ids', () => {
    const m = parseGmailMessage({
      id: 'm1', threadId: 'th1', internalDate: '1761556440000', snippet: 'snip',
      payload: { headers: [{ name: 'From', value: FOG.from }, { name: 'To', value: 'sales@kestrel-sensing.example' }, { name: 'Subject', value: FOG.subject }], mimeType: 'multipart/mixed', parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64u(FOG.body) } }, { mimeType: 'text/html', body: { data: b64u('<p>html</p>') } }] },
        { mimeType: 'application/pdf', filename: 'spec.pdf', body: { attachmentId: 'ANGjdJ_1', size: 1200 } },
      ] },
    });
    expect(m).toMatchObject({ from: FOG.from, subject: FOG.subject, body: FOG.body, threadId: 'th1', receivedAt: '2025-10-27T09:14:00.000Z' });
    expect(m.attachments).toEqual([{ filename: 'spec.pdf', mimetype: 'application/pdf', ref: 'ANGjdJ_1' }]);
  });
  it('Gmail: falls back to html text when there is no plain part', () => {
    const m = parseGmailMessage({ id: 'm', payload: { headers: [], mimeType: 'text/html', body: { data: b64u('<div>Please quote<br>10 units</div>') }, parts: [{ mimeType: 'text/html', body: { data: b64u('<div>Please quote<br>10 units</div>') } }] } });
    expect(m.body).toBe('Please quote\n10 units');
  });
  it('Outlook: reads sender, html body and received time', () => {
    const m = parseOutlookMessage({ subject: 'RFQ', from: { emailAddress: { address: 'a@b.example' } }, toRecipients: [{ emailAddress: { address: 'me@x.example' } }], body: { contentType: 'html', content: '<p>Quote <b>5</b> loggers</p>' }, receivedDateTime: '2026-10-28T08:00:00Z', conversationId: 'conv1' });
    expect(m).toMatchObject({ from: 'a@b.example', to: 'me@x.example', subject: 'RFQ', body: 'Quote 5 loggers', threadId: 'conv1' });
  });
  it('fetches Gmail attachments through the proxy and skips ones that fail', async () => {
    const proxy = async (r: { endpoint: string }) => {
      if (r.endpoint.endsWith('/attachments/A1')) return { status: 200, data: { data: b64u('%PDF-1.4 fake') } };
      if (r.endpoint.endsWith('/attachments/A2')) return { status: 404, data: {} };
      return { status: 200, data: { response_data: { id: 'm1', payload: { headers: [], mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64u('see attached') } }, { filename: 'a.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A1' } }, { filename: 'b.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A2' } }] } } } };
    };
    const r = await fetchGmail(proxy as never, 'm1');
    expect(r.files.map((f) => f.filename)).toEqual(['a.pdf']);
    expect(new TextDecoder().decode(r.files[0]!.bytes)).toBe('%PDF-1.4 fake');
  });
  it('fetches Outlook file attachments and skips inline and item attachments', async () => {
    const proxy = async (r: { endpoint: string }) => r.endpoint.endsWith('/attachments')
      ? { status: 200, data: { value: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'rfp.docx', contentType: 'application/x', contentBytes: Buffer.from('docx-bytes').toString('base64') }, { '@odata.type': '#microsoft.graph.fileAttachment', isInline: true, name: 'logo.png', contentBytes: 'AAAA' }, { '@odata.type': '#microsoft.graph.itemAttachment', name: 'fwd' }] } }
      : { status: 200, data: { subject: 's', hasAttachments: true, body: { contentType: 'text', content: 'b' } } };
    const r = await fetchOutlook(proxy as never, 'AAMk1');
    expect(r.files.map((f) => f.filename)).toEqual(['rfp.docx']);
  });
  it('maps attachment types to document kinds and drops what Pactovio cannot read', () => {
    expect(['a.pdf', 'b.DOCX', 'c.xlsx', 'd.csv', 'e.png', 'f.zip', 'g.exe', 'h'].map(docKind)).toEqual(['pdf', 'docx', 'xlsx', 'xlsx', 'image', 'zip', null, null]);
  });
});

describe('classifyEmail (Lightning, thinking off, json_schema)', () => {
  const env = { NEBIUS_API_KEY: 'k' } as Env;
  it('asks MODEL_FAST for the four-door schema with thinking disabled and returns the parsed result', async () => {
    const seen: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const out = await classifyEmail(env, FOG, { fetch: tokenFactory({ door: 'design', confidence: 0.93, reason: 'Technical requirements and a request to design and quote', customer: 'Westbay Port Authority', subject: 'Fog monitoring, Berths 4 to 9' }, seen) });
    expect(out).toMatchObject({ door: 'design', customer: 'Westbay Port Authority' });
    expect(seen[0]).toMatchObject({ model: 'nvidia/Nemotron-3_5-Lightning', chat_template_kwargs: { enable_thinking: false }, temperature: 0 });
    expect(seen[0]!.response_format.json_schema.schema.properties.door.enum).toEqual(['tender', 'rfp', 'design', 'other']);
    expect(seen[0]!.messages[1].content).toContain('Fog monitoring for the Berth 4');
  });
  it('retries once on invalid JSON, then falls back to the keyword heuristic with low confidence', async () => {
    const f = tokenFactory('not json at all');
    const out = await classifyEmail(env, FOG, { fetch: f });
    expect(out).toMatchObject({ door: 'design', confidence: 0.4 });
    expect(out.reason).toMatch(/fallback/i);
  });
  it('heuristic: newsletters are other, RFPs are rfp', () => {
    expect(heuristicClassify({ ...FOG, subject: 'This week: 5 new fog sensors reviewed', body: 'Meteo Instruments Weekly | Issue 212 Advertise with us' }).door).toBe('other');
    expect(heuristicClassify(RFP).door).toBe('rfp');
  });
});

describe('intake pipeline', () => {
  let env: Env;
  let dispose: () => Promise<void>;
  const job = (id: string, over: Partial<IntakeJob> = {}): IntakeJob => ({ intakeId: id, workspaceId: 'ws_harbour_digital', source: 'gmail', provider: 'gmail', messageId: 'm-1', candidates: ['ws_harbour_digital', 'ws_kestrel_sensing'], ...over });
  const insert = (id: string, ws = 'ws_harbour_digital') => env.DB.prepare("INSERT INTO intakes (id, workspace_id, door, source, title, received_at, status) VALUES (?, ?, 'rfp', 'gmail', 't', '2026-10-30T00:00:00Z', 'new')").bind(id, ws).run();
  beforeAll(async () => {
    ({ env, dispose } = await makeEnv());
    env = { ...env, COMPOSIO_API_KEY: 'k', NEBIUS_API_KEY: 'k' } as Env;
    const live = { status: 'connected' as const, external_account_id: 'ca_gmail', connected_at: '2026-10-30T00:00:00Z', meta: { composio_user_id: 'pactovio-demo' } };
    await saveConnector(env, 'ws_harbour_digital', 'gmail', live);
    await saveConnector(env, 'ws_kestrel_sensing', 'gmail', live);
  }, 60_000);
  afterAll(async () => dispose?.());
  beforeEach(() => { lane.match.mockReset(); lane.run.mockReset(); });

  it('stores the message and attachments in R2 with documents rows, from the mailbox through Composio', async () => {
    await insert('int_fetch');
    const gmailMsg = {
      id: 'm-1', threadId: 'th-9', internalDate: '1761556440000',
      payload: {
        headers: [{ name: 'From', value: RFP.from }, { name: 'Subject', value: RFP.subject }], mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain', body: { data: b64u(RFP.body) } }, { filename: 'RFP.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A1' } }],
      },
    };
    const f = fakeComposio(RESPONSES, { proxy: (r) => (String(r.endpoint).includes('/attachments/') ? { status: 200, data: { data: b64u('%PDF-1.4 rfp') } } : { status: 200, data: gmailMsg }) });
    const msg = await fetchAndStore(env, job('int_fetch'), { fetch: f.fetch });
    expect(msg).toMatchObject({ subject: RFP.subject, threadId: 'th-9', attachments: [{ filename: 'RFP.pdf', r2Key: 'intakes/int_fetch/0-RFP.pdf' }] });
    const docs = await env.DB.prepare('SELECT filename, kind, r2_key FROM documents WHERE intake_id = ? ORDER BY filename').bind('int_fetch').all<{ filename: string; kind: string }>();
    expect(docs.results.map((d) => `${d.filename}:${d.kind}`)).toEqual(['RFP.pdf:pdf', 'message.txt:email']);
    expect(await (await env.FILES.get('intakes/int_fetch/0-RFP.pdf'))!.text()).toBe('%PDF-1.4 rfp');
  });

  it('falls back to the trigger payload when the mailbox fetch fails', async () => {
    await insert('int_hint');
    const f = fakeComposio(RESPONSES, { proxy: () => ({ status: 500, data: {} }) });
    const msg = await fetchAndStore(env, job('int_hint', { hint: { from: 'a@b.example', subject: 'From the trigger', body: 'preview text' } }), { fetch: f.fetch });
    expect(msg).toMatchObject({ subject: 'From the trigger', body: 'preview text', attachments: [] });
  });

  it('design request: classify moves it to the industrial workspace, routes to lane C and announces it with ids', async () => {
    await insert('int_design');
    const f = tokenFactory({ door: 'design', confidence: 0.94, reason: 'Technical requirements', customer: 'Westbay Port Authority', subject: 'Fog monitoring, Berths 4 to 9' });
    const { cls, workspaceId } = await classifyStep(env, job('int_design', { messageId: 'm-d' }), FOG, { fetch: f });
    expect(workspaceId).toBe('ws_kestrel_sensing');
    lane.match.mockResolvedValue({});
    const r = await routeStep(env, job('int_design'), workspaceId, FOG, cls);
    expect(r.designRequestId).toMatch(/^dsg_/);
    expect(lane.match).toHaveBeenCalledWith(env, r.designRequestId);
    const i = await env.DB.prepare('SELECT * FROM intakes WHERE id = ?').bind('int_design').first<Record<string, string>>();
    expect(i).toMatchObject({ workspace_id: 'ws_kestrel_sensing', door: 'design', status: 'ready', design_request_id: r.designRequestId });
    const d = await env.DB.prepare('SELECT customer, spec_text FROM design_requests WHERE id = ?').bind(r.designRequestId).first<Record<string, string>>();
    expect(d).toMatchObject({ customer: 'Westbay Port Authority' });
    expect(d!.spec_text).toContain('RS-485');
    const ev = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'intake.classified' AND workspace_id = 'ws_kestrel_sensing' ORDER BY at DESC LIMIT 1").first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json)).toMatchObject({ intake_id: 'int_design', door: 'design', design_request_id: r.designRequestId, sender: 'Ciarán Doyle' });
  });

  it('lane C not ready: the intake stays classified and the design request exists', async () => {
    await insert('int_design2', 'ws_kestrel_sensing');
    lane.match.mockRejectedValue(new NotImplemented('quote.matchDesignRequest'));
    const r = await routeStep(env, job('int_design2', { workspaceId: 'ws_kestrel_sensing' }), 'ws_kestrel_sensing', FOG, { door: 'design', confidence: 0.9, reason: 'r', customer: '', subject: 'Fog' });
    expect(r.note).toBe('design match not available yet');
    expect((await env.DB.prepare("SELECT status FROM intakes WHERE id = 'int_design2'").first<{ status: string }>())!.status).toBe('classified');
  });

  it('RFP: creates an upload tender, links the documents and starts the pack run', async () => {
    await insert('int_rfp');
    await env.DB.prepare("INSERT INTO documents (id, intake_id, workspace_id, filename, kind, r2_key) VALUES ('doc_rfp1', 'int_rfp', 'ws_harbour_digital', 'RFP.pdf', 'pdf', 'intakes/int_rfp/0-RFP.pdf')").run();
    lane.run.mockResolvedValue('run_abc');
    const r = await routeStep(env, job('int_rfp'), 'ws_harbour_digital', RFP, { door: 'rfp', confidence: 0.95, reason: 'RFP with deadline', customer: 'Corran County Council', subject: 'Planning enforcement case management (RFP CCC-2026-14)' });
    expect(lane.run).toHaveBeenCalledWith(env, { workspaceId: 'ws_harbour_digital', tenderId: r.tenderId });
    const t = await env.DB.prepare('SELECT source, source_ref, buyer, buyer_key FROM tenders WHERE id = ?').bind(r.tenderId).first<Record<string, string>>();
    expect(t).toMatchObject({ source: 'upload', source_ref: 'int_rfp', buyer: 'Corran County Council', buyer_key: 'corran-county-council' });
    expect((await env.DB.prepare("SELECT tender_id FROM documents WHERE id = 'doc_rfp1'").first<{ tender_id: string }>())!.tender_id).toBe(r.tenderId);
    expect(await env.DB.prepare("SELECT status, tender_id FROM intakes WHERE id = 'int_rfp'").first()).toMatchObject({ status: 'processing', tender_id: r.tenderId });
    expect(r.runId).toBe('run_abc');
  });

  it('other: the intake is ignored, nothing is created, no draft is written', async () => {
    await insert('int_news');
    const cls = { door: 'other' as const, confidence: 0.9, reason: 'Newsletter', customer: '', subject: 'Weekly' };
    const f = tokenFactory(cls);
    const c = await classifyStep(env, job('int_news'), { ...FOG, subject: 'Weekly' }, { fetch: f });
    expect(await env.DB.prepare("SELECT status FROM intakes WHERE id = 'int_news'").first()).toMatchObject({ status: 'ignored' });
    const composio = fakeComposio(RESPONSES);
    expect(await draftStep(env, job('int_news'), c.workspaceId, FOG, c.cls, { fetch: composio.fetch })).toMatchObject({ drafted: false });
    expect(composio.calls).toHaveLength(0);
  });

  it('writes the reply as a Gmail draft in the thread, never sends, and requests approval', async () => {
    const f = fakeComposio(RESPONSES);
    const r = await draftStep(env, job('int_design'), 'ws_kestrel_sensing', { ...FOG, threadId: 'th-9' }, { door: 'design', confidence: 0.9, reason: 'r', customer: '', subject: 'Fog' }, { fetch: f.fetch });
    expect(r).toMatchObject({ drafted: true, draftId: 'r-9001' });
    expect(f.calls.map((c) => c.tool)).toEqual(['GMAIL_CREATE_EMAIL_DRAFT']);
    expect(f.calls[0]!.args).toMatchObject({ recipient_email: 'ciaran.doyle@westbay-port.example', thread_id: 'th-9' });
    expect(f.calls[0]!.args.body).toContain('Draft prepared by Pactovio');
    const ev = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'approval.requested' AND workspace_id = 'ws_kestrel_sensing' ORDER BY at DESC LIMIT 1").first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json)).toMatchObject({ kind: 'intake_reply', intake_id: 'int_design' });
  });

  it('a failed draft does not fail the intake and requests no approval', async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'approval.requested'").first<{ n: number }>())!.n;
    const f = fakeComposio(RESPONSES, { failTools: { GMAIL_CREATE_EMAIL_DRAFT: 'insufficientPermissions' } });
    const r = await draftStep(env, job('int_design'), 'ws_kestrel_sensing', FOG, { door: 'design', confidence: 0.9, reason: 'r', customer: '', subject: 'Fog' }, { fetch: f.fetch });
    expect(r).toMatchObject({ drafted: false, error: expect.stringContaining('insufficientPermissions') });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'approval.requested'").first<{ n: number }>())!.n).toBe(before);
  });
});
