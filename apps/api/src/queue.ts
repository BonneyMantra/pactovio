import type { Env } from '@pactovio/contracts/env';
import type { PactovioEvent } from '@pactovio/contracts';
import * as connectors from '@pactovio/connectors';
import { deriveWebhookSecret, signWebhook } from '@pactovio/events';

/** Seconds to wait before attempt n+1 (n = attempts so far). Queue max_retries = 3, so attempts 1..4. */
export const BACKOFF_SEC = [15, 60, 300] as const;
export const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;

interface Endpoint { id: string; url: string; events_json: string }

/** Fan-out target filter: an empty `events` list means every event type. */
export function wants(eventsJson: string, type: string): boolean {
  try {
    const list = JSON.parse(eventsJson) as string[];
    return list.length === 0 || list.includes(type) || list.includes('*');
  } catch { return false; }
}

async function deliverOne(env: Env, ep: Endpoint, event: PactovioEvent, attempt: number): Promise<boolean> {
  const did = `dlv_${event.id}_${ep.id}`;
  const prior = await env.DB.prepare('SELECT status FROM webhook_deliveries WHERE id = ?').bind(did).first<{ status: string }>();
  if (prior?.status === 'delivered') return true; // a retry of the batch must not re-send to endpoints that already got it
  const body = JSON.stringify({ id: event.id, type: event.type, workspace_id: event.workspace_id, created_at: event.at, data: event.payload });
  let code: number | null = null;
  let ok = false;
  try {
    const secret = await deriveWebhookSecret(env, ep.id);
    const res = await fetch(ep.url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': 'Pactovio-Webhooks/1', 'x-pactovio-event': event.type, 'x-pactovio-delivery': did, 'x-pactovio-signature': await signWebhook(secret, body) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    code = res.status;
    ok = res.status >= 200 && res.status < 300;
  } catch { /* network error or timeout: logged as failed below */ }
  const status = ok ? 'delivered' : attempt >= MAX_ATTEMPTS ? 'failed' : 'retrying';
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, endpoint_id, event, status, attempts, response_code, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET status = ?4, attempts = ?5, response_code = ?6, at = ?7`,
  ).bind(did, ep.id, event.type, status, attempt, code, new Date().toISOString()).run();
  return ok;
}

/** Deliver one event to the workspace's active endpoints. Returns true when nothing needs a retry. */
export async function fanOut(env: Env, event: PactovioEvent, attempt: number): Promise<boolean> {
  const { results } = await env.DB.prepare('SELECT id, url, events_json FROM webhook_endpoints WHERE workspace_id = ? AND active = 1').bind(event.workspace_id).all<Endpoint>();
  const targets = results.filter((e) => wants(e.events_json, event.type));
  const outcomes = await Promise.all(targets.map((e) => deliverOne(env, e, event, attempt)));
  return outcomes.every(Boolean);
}

/** Lane D's connector actions (Slack post, CRM update...). Guarded until implemented; never fails delivery. */
async function runActions(env: Env, event: PactovioEvent): Promise<void> {
  const fn = (connectors as Record<string, unknown>).runEventActions;
  if (typeof fn !== 'function') return;
  try { await (fn as (e: Env, ev: PactovioEvent) => Promise<unknown>)(env, event); } catch (e) {
    console.error('runEventActions failed', e instanceof Error ? e.message : 'unknown');
  }
}

/** Queue consumer for `pactovio-events`: signed webhook delivery with backoff and a delivery log, then connector actions (once, first attempt). */
export async function handleEvents(batch: MessageBatch<PactovioEvent>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const attempt = msg.attempts ?? 1;
    try {
      if (attempt === 1) await runActions(env, msg.body);
      const done = await fanOut(env, msg.body, attempt);
      if (done) msg.ack();
      else if (attempt >= MAX_ATTEMPTS) msg.ack();
      else msg.retry({ delaySeconds: BACKOFF_SEC[attempt - 1] });
    } catch (e) {
      console.error('event fan-out failed', e instanceof Error ? e.message : 'unknown');
      if (attempt >= MAX_ATTEMPTS) msg.ack(); else msg.retry({ delaySeconds: BACKOFF_SEC[attempt - 1] });
    }
  }
}
