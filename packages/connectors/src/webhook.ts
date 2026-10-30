import { newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { splitAddress } from './inbound-mail';
import type { IntakeJob } from './intake';
import { saveConnector, connectorsForAccount } from './store';
import { verifyComposioWebhook } from './signature';

export interface WebhookResult { status: number; body: Record<string, unknown> }
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAIL: Record<string, 'gmail' | 'outlook'> = { GMAIL_NEW_GMAIL_MESSAGE: 'gmail', OUTLOOK_MESSAGE_TRIGGER: 'outlook' };

interface Envelope { id: string | null; type: string; slug: string; triggerId: string | null; accountId: string | null; data: Json }

/** V3 (`metadata` + `data`), with V2 (`type` is the lowercase slug, ids inside `data`) accepted. */
export function parseEnvelope(raw: Json): Envelope {
  const meta = (raw.metadata ?? {}) as Json;
  const data = (raw.data ?? raw.payload ?? {}) as Json;
  const slug = String(meta.trigger_slug ?? (raw.type && raw.type !== 'composio.trigger.message' ? raw.type : raw.trigger_name ?? '')).toUpperCase();
  return {
    id: (raw.id as string | undefined) ?? (raw.log_id as string | undefined) ?? null, type: String(raw.type ?? 'composio.trigger.message'), slug,
    triggerId: (meta.trigger_id ?? data.trigger_id ?? raw.trigger_id ?? null) as string | null,
    accountId: (meta.connected_account_id ?? data.connection_id ?? raw.connection_id ?? null) as string | null, data,
  };
}

/** What the trigger payload already tells us (used when the mailbox fetch fails). */
export function mailHint(provider: 'gmail' | 'outlook', d: Json): { messageId: string | null; from?: string; subject?: string; body?: string; receivedAt?: string } {
  if (provider === 'gmail') {
    return { messageId: (d.message_id ?? d.id ?? null) as string | null, from: d.sender, subject: d.subject, body: d.message_text, receivedAt: typeof d.message_timestamp === 'string' ? new Date(d.message_timestamp).toISOString?.() : undefined };
  }
  const m = (d.outlook_message ?? d.message ?? {}) as Json;
  return {
    messageId: (d.id ?? m.id ?? null) as string | null, from: m.from?.emailAddress?.address ?? m.sender?.emailAddress?.address, subject: m.subject,
    body: m.bodyPreview ?? m.body?.content, receivedAt: m.receivedDateTime,
  };
}

/**
 * POST /webhooks/composio. Verify the signature, ignore everything but new-mail triggers (and flag expired connections),
 * dedupe redeliveries, open an `intakes` row and start IntakeWorkflow. Answers fast: the work happens in the workflow.
 */
export async function handleComposioWebhook(env: Env, rawBody: string, headers: { get(n: string): string | null }, now = Math.floor(Date.now() / 1000)): Promise<WebhookResult> {
  const v = await verifyComposioWebhook(env.COMPOSIO_WEBHOOK_SECRET, headers, rawBody, now);
  if (!v.ok) return { status: v.reason === 'no_secret' ? 503 : 401, body: { error: v.reason === 'no_secret' ? 'Webhook secret not configured' : 'Invalid webhook signature', code: v.reason === 'no_secret' ? 'not_configured' : 'unauthorized' } };
  let raw: Json;
  try { raw = JSON.parse(rawBody) as Json; } catch { return { status: 400, body: { error: 'Body is not JSON', code: 'validation' } }; }
  const env_ = parseEnvelope(raw);

  if (env_.type === 'composio.connected_account.expired' && env_.accountId) {
    for (const row of await connectorsForAccount(env, env_.accountId)) await saveConnector(env, row.workspace_id, row.provider, { status: 'error', meta: { ...row.meta, last_error: 'The Composio connection expired; reconnect it.' } });
    return { status: 200, body: { ok: true, handled: 'connection_expired' } };
  }
  const provider = MAIL[env_.slug];
  if (!provider || !env_.accountId) return { status: 200, body: { ok: true, ignored: env_.slug || env_.type } };

  const whId = headers.get('webhook-id') ?? env_.id;
  if (whId && (await env.CACHE.get(`cx:wh:${whId}`))) return { status: 200, body: { ok: true, duplicate: true } };
  const hint = mailHint(provider, env_.data);
  if (!hint.messageId) return { status: 200, body: { ok: true, ignored: 'no message id' } };
  const msgKey = `cx:msg:${env_.accountId}:${hint.messageId}`;
  if (await env.CACHE.get(msgKey)) return { status: 200, body: { ok: true, duplicate: true } };

  // The mailbox may be shared by several sample workspaces: the one that owns the trigger wins, else the first.
  const rows = (await connectorsForAccount(env, env_.accountId)).filter((r) => r.provider === provider);
  if (!rows.length) return { status: 200, body: { ok: true, ignored: 'no workspace owns this mailbox' } };
  const owner = rows.find((r) => (r.meta.config?.trigger as { id?: string } | undefined)?.id === env_.triggerId) ?? rows[0]!;
  const intakeId = newId('intake');
  const received = hint.receivedAt ?? new Date(now * 1000).toISOString();
  const sender = splitAddress(hint.from ?? '');
  await env.DB.prepare("INSERT INTO intakes (id, workspace_id, door, source, title, sender, received_at, status) VALUES (?, ?, 'rfp', ?, ?, ?, ?, 'new')")
    .bind(intakeId, owner.workspace_id, provider, (hint.subject ?? '(no subject)').slice(0, 200), sender.name ? `${sender.name} <${sender.address}>` : sender.address || null, received).run();
  const job: IntakeJob = { intakeId, workspaceId: owner.workspace_id, source: provider, provider, messageId: hint.messageId, candidates: rows.map((r) => r.workspace_id), hint: { from: hint.from, subject: hint.subject, body: hint.body, receivedAt: received } };
  try {
    await env.INTAKE.create({ id: intakeId, params: job });
  } catch (e) {
    await env.DB.prepare("UPDATE intakes SET status = 'ignored' WHERE id = ?").bind(intakeId).run();
    console.error('IntakeWorkflow start failed', e instanceof Error ? e.message : 'unknown');
    return { status: 502, body: { error: 'Could not start the intake workflow', code: 'upstream' } };
  }
  await Promise.all([whId ? env.CACHE.put(`cx:wh:${whId}`, '1', { expirationTtl: 86_400 }) : undefined, env.CACHE.put(msgKey, intakeId, { expirationTtl: 7 * 86_400 })]);
  await emit(env, owner.workspace_id, 'intake.received', { intake_id: intakeId, source: provider, title: hint.subject ?? null, sender: sender.name || sender.address || null });
  return { status: 200, body: { ok: true, intake_id: intakeId } };
}

