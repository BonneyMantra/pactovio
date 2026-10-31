import { NotImplemented, newId, type DocKind, type IntakeSource } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { matchDesignRequest } from '@pactovio/quote';
import { classifyEmail, type Classification, type InboundMessage } from './classify';
import { budgetMessage, isBudgetError } from '@pactovio/models';
import { fetchGmail, fetchOutlook, splitAddress, type RawFile } from './inbound-mail';
import { makeCtx, runAction, type Deps } from './runtime';
import { getConnector, isLive } from './store';
import { mimeFor, truncate } from './util';

export interface IntakeJob {
  intakeId: string;
  workspaceId: string;
  source: IntakeSource;
  provider?: 'gmail' | 'outlook';
  messageId?: string;
  /** Workspaces sharing the mailbox's Composio account (design requests prefer the industrial one). */
  candidates?: string[];
  /** Trigger payload fields, used if the mailbox fetch fails. */
  hint?: { from?: string; subject?: string; body?: string; receivedAt?: string };
  /** Upload/paste intakes: the message is already stored (documents rows exist), skip the mailbox fetch. */
  prestored?: InboundMessage;
  /** The user chose the door on upload/paste: skip classification. */
  forceDoor?: 'tender' | 'rfp' | 'design';
}

const KIND_BY_EXT: Record<string, DocKind> = { pdf: 'pdf', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', csv: 'xlsx', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', tif: 'image', tiff: 'image', zip: 'zip' };
export const docKind = (filename: string): DocKind | null => KIND_BY_EXT[filename.split('.').pop()?.toLowerCase() ?? ''] ?? null;
const safeName = (f: string) => f.replace(/[^\w.\- ]+/g, '_').slice(0, 120);

/** Store the message body and attachments in R2 and register `documents` rows. Returns the model-facing message. */
export async function storeMessage(env: Env, job: IntakeJob, m: { from: string; to?: string; subject: string; body: string; receivedAt: string; threadId?: string | null }, files: RawFile[]): Promise<InboundMessage> {
  const base = `intakes/${job.intakeId}`;
  const textKey = `${base}/message.txt`;
  await env.FILES.put(textKey, `From: ${m.from}\nTo: ${m.to ?? ''}\nSubject: ${m.subject}\nDate: ${m.receivedAt}\n\n${m.body}`, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  const stmts = [env.DB.prepare('INSERT OR IGNORE INTO documents (id, intake_id, workspace_id, filename, kind, r2_key, text_r2_key, is_form) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .bind(`doc_${job.intakeId.slice(4)}_msg`, job.intakeId, job.workspaceId, 'message.txt', 'email', textKey, textKey)];
  const attachments: InboundMessage['attachments'] = [];
  for (const [i, f] of files.entries()) {
    const kind = docKind(f.filename);
    if (!kind) continue; // unsupported type: listed in the classifier prompt only if stored
    const key = `${base}/${i}-${safeName(f.filename)}`;
    await env.FILES.put(key, f.bytes, { httpMetadata: { contentType: f.mimetype || mimeFor(f.filename) } });
    attachments.push({ filename: f.filename, r2Key: key });
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO documents (id, intake_id, workspace_id, filename, kind, r2_key, is_form) VALUES (?, ?, ?, ?, ?, ?, 0)').bind(`doc_${job.intakeId.slice(4)}_${i}`, job.intakeId, job.workspaceId, f.filename, kind, key));
  }
  await env.DB.batch(stmts);
  return { id: job.messageId ?? job.intakeId, from: m.from, to: m.to, subject: m.subject, body: m.body, attachments, receivedAt: m.receivedAt, threadId: m.threadId ?? undefined, provider: job.provider };
}

/** Workflow step 1 for mailbox intakes: fetch the message and its attachments through Composio, store them. Falls back to the trigger payload. */
export async function fetchAndStore(env: Env, job: IntakeJob, deps: Deps = {}): Promise<InboundMessage> {
  if (job.prestored) return job.prestored;
  const row = job.provider ? await getConnector(env, job.workspaceId, job.provider) : null;
  let mail = null as Awaited<ReturnType<typeof fetchGmail>> | null;
  if (isLive(row) && job.provider && job.messageId) {
    const ctx = makeCtx(env, row, deps);
    try { mail = await (job.provider === 'gmail' ? fetchGmail : fetchOutlook)(ctx.proxy, job.messageId); }
    catch (e) { console.error('mailbox fetch failed, using trigger payload', e instanceof Error ? e.message : 'unknown'); }
  }
  const h = job.hint ?? {};
  const m = mail?.mail;
  return storeMessage(env, job, {
    from: m?.from || h.from || 'unknown sender', to: m?.to, subject: m?.subject || h.subject || '(no subject)', body: m?.body || h.body || '',
    receivedAt: m?.receivedAt ?? h.receivedAt ?? new Date().toISOString(), threadId: m?.threadId,
  }, mail?.files ?? []);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';

/** Workflow step 2: classify with Lightning, record it, and move the intake to the right workspace of a shared mailbox. */
export async function classifyStep(env: Env, job: IntakeJob, msg: InboundMessage, deps: Deps = {}): Promise<{ cls: Classification; workspaceId: string }> {
  let cls: Classification;
  try {
    cls = job.forceDoor
      ? { door: job.forceDoor, confidence: 1, reason: 'Door chosen by the user', customer: '', subject: msg.subject }
      : await classifyEmail(env, msg, { fetch: deps.fetch });
  } catch (e) {
    if (isBudgetError(e)) { // honest state: the intake waits; nothing is guessed
      await env.DB.prepare("UPDATE intakes SET status = 'new', classification_json = ? WHERE id = ?").bind(JSON.stringify({ reason: budgetMessage(e) }), job.intakeId).run();
    }
    throw e;
  }
  let ws = job.workspaceId;
  if (cls.door === 'design' && (job.candidates?.length ?? 0) > 1) {
    const ph = job.candidates!.map(() => '?').join(',');
    const ind = await env.DB.prepare(`SELECT id FROM workspaces WHERE segment = 'industrial' AND id IN (${ph}) LIMIT 1`).bind(...job.candidates!).first<{ id: string }>();
    if (ind) ws = ind.id;
  }
  const door = cls.door === 'other' ? null : cls.door;
  await env.DB.batch([
    env.DB.prepare("UPDATE intakes SET classification_json = ?, workspace_id = ?, status = ?" + (door ? ', door = ?' : '') + ' WHERE id = ?')
      .bind(...[JSON.stringify(cls), ws, door ? 'classified' : 'ignored', ...(door ? [door] : []), job.intakeId]),
    env.DB.prepare('UPDATE documents SET workspace_id = ? WHERE intake_id = ?').bind(ws, job.intakeId),
  ]);
  return { cls, workspaceId: ws };
}

async function createDesignRequest(env: Env, job: IntakeJob, ws: string, msg: InboundMessage, cls: Classification): Promise<string> {
  const id = newId('designRequest');
  const sender = splitAddress(msg.from);
  const customer = cls.customer || sender.name || sender.address.split('@')[1] || 'Unknown customer';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO design_requests (id, workspace_id, intake_id, customer, subject, spec_text, status) VALUES (?, ?, ?, ?, ?, ?, 'new')").bind(id, ws, job.intakeId, customer, truncate(cls.subject || msg.subject, 200), msg.body.slice(0, 20_000)),
    env.DB.prepare('UPDATE intakes SET design_request_id = ?, status = ? WHERE id = ?').bind(id, 'processing', job.intakeId),
  ]);
  return id;
}

async function createTenderFromRfp(env: Env, job: IntakeJob, msg: InboundMessage, cls: Classification): Promise<string> {
  const id = newId('tender');
  const sender = splitAddress(msg.from);
  const buyer = cls.customer || sender.name || sender.address.split('@')[1] || 'Unknown buyer';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, raw_json) VALUES (?, 'upload', ?, ?, ?, ?, '', ?)")
      .bind(id, job.intakeId, truncate(cls.subject || msg.subject, 200), buyer, slug(buyer), JSON.stringify({ intake_id: job.intakeId, from: msg.from, received_at: msg.receivedAt })),
    env.DB.prepare('UPDATE documents SET tender_id = ? WHERE intake_id = ?').bind(id, job.intakeId),
    env.DB.prepare('UPDATE intakes SET tender_id = ?, status = ? WHERE id = ?').bind(id, 'processing', job.intakeId),
  ]);
  return id;
}

/** Workflow step 3: open the right object for the door, start the engine, then announce `intake.classified` (ids included). */
export async function routeStep(env: Env, job: IntakeJob, ws: string, msg: InboundMessage, cls: Classification): Promise<{ tenderId: string | null; designRequestId: string | null; runId: string | null; note: string | null }> {
  let tenderId: string | null = null; let designRequestId: string | null = null; let runId: string | null = null; let note: string | null = null;
  try {
    if (cls.door === 'design') {
      designRequestId = await createDesignRequest(env, job, ws, msg, cls);
      try { await matchDesignRequest(env, designRequestId); await env.DB.prepare("UPDATE intakes SET status = 'ready' WHERE id = ?").bind(job.intakeId).run(); }
      catch (e) { note = e instanceof NotImplemented ? 'design match not available yet' : `design match failed: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`; await env.DB.prepare("UPDATE intakes SET status = 'classified' WHERE id = ?").bind(job.intakeId).run(); }
    } else if (cls.door === 'rfp' || cls.door === 'tender') {
      tenderId = await createTenderFromRfp(env, job, msg, cls);
      // Spend cap: never start a fresh pack read on its own. The tender waits for a person to press Fresh read.
      await env.DB.prepare("UPDATE intakes SET status = 'classified' WHERE id = ?").bind(job.intakeId).run();
    }
  } catch (e) {
    note = `routing failed: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown'}`;
    console.error('intake routing failed', job.intakeId, note);
  }
  if (note) console.error('intake routing note', job.intakeId, note);
  const sender = splitAddress(msg.from);
  await emit(env, ws, 'intake.classified', {
    intake_id: job.intakeId, door: cls.door === 'other' ? 'ignore' : cls.door, title: cls.subject || msg.subject, subject: msg.subject, sender: sender.name || sender.address,
    confidence: cls.confidence, reason: cls.reason, source: job.source, tender_id: tenderId, design_request_id: designRequestId, run_id: runId,
  });
  return { tenderId, designRequestId, runId, note };
}

const ack = (door: Classification['door'], msg: InboundMessage, workspaceName: string): string => {
  const name = splitAddress(msg.from).name.split(' ')[0] || 'there';
  const lines = door === 'design'
    ? [`Hello ${name},`, '', `Thank you for your enquiry: "${truncate(msg.subject, 120)}". We have logged your requirements and are checking them against our product range. We will come back with a technical proposal and a quote shortly.`, '', 'If any requirement is firm (a protocol, an accuracy or an installation constraint), please reply with the detail.']
    : [`Dear ${name === 'there' ? 'Sir or Madam' : name},`, '', `We acknowledge receipt of "${truncate(msg.subject, 120)}" and the attached documents. We are reviewing them and will confirm our intention to respond, and send any clarification questions, before the deadline.`];
  return [...lines, '', 'Kind regards,', workspaceName, '', '(Draft prepared by Pactovio. Review before sending; Pactovio never sends mail.)'].join('\n');
};

/** Workflow step 4: save a reply as a DRAFT in the same mailbox (never sent) and ask for approval. */
export async function draftStep(env: Env, job: IntakeJob, ws: string, msg: InboundMessage, cls: Classification, deps: Deps = {}): Promise<{ drafted: boolean; draftId: string | null; error: string | null }> {
  if (cls.door === 'other' || !job.provider) return { drafted: false, draftId: null, error: null };
  const to = splitAddress(msg.from).address;
  const wsName = (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(ws).first<{ name: string }>())?.name ?? 'Sales';
  const body = ack(cls.door, msg, wsName);
  const input = job.provider === 'gmail'
    ? { to, body, thread_id: msg.threadId, subject: `Re: ${msg.subject}` }
    : { to, body, message_id: job.messageId, subject: `Re: ${msg.subject}` };
  const res = await runAction(env, ws, job.provider, 'create_draft', input, deps);
  const draftId = (res.output as { id?: string | null } | undefined)?.id ?? null;
  const error = res.ok ? null : String((res.output as { error?: string } | undefined)?.error ?? 'draft failed');
  if (res.ok) {
    await emit(env, ws, 'approval.requested', {
      kind: 'intake_reply', subject_id: job.intakeId, intake_id: job.intakeId, title: msg.subject, summary: `A reply to ${to} is waiting as a draft in your ${job.provider === 'gmail' ? 'Gmail' : 'Outlook'}. Pactovio never sends mail: review it there.`,
    });
  } else console.error('reply draft failed', job.intakeId, error);
  return { drafted: res.ok, draftId, error };
}

export async function markIntakeStatus(env: Env, intakeId: string, status: string): Promise<void> {
  await env.DB.prepare('UPDATE intakes SET status = ? WHERE id = ?').bind(status, intakeId).run();
}

