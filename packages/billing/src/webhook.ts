import type { PlanId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { dodoProducts } from './dodo';
import { grantCredits } from './ledger';
import { planCredits } from './plans';

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const safeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/** Sign like the Standard Webhooks spec (used by tests and local replays). */
export async function standardSign(secret: string, id: string, ts: string | number, body: string): Promise<string> {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = await crypto.subtle.importKey('raw', unb64(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `v1,${b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)))}`;
}

/** Standard Webhooks verification: headers webhook-id, webhook-timestamp, webhook-signature ("v1,sig v1,sig2"). 5 min tolerance. */
export async function verifyStandardWebhook(secret: string, headers: { id?: string | null; timestamp?: string | null; signature?: string | null }, body: string, toleranceSec = 300): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  let expected: string;
  try { expected = await standardSign(secret, id, timestamp, body); } catch { return false; }
  return signature.split(' ').some((s) => safeEq(s.trim(), expected));
}

interface DodoPayload {
  type?: string;
  data?: {
    subscription_id?: string; payment_id?: string; product_id?: string; status?: string; next_billing_date?: string;
    customer?: { customer_id?: string }; metadata?: Record<string, string>;
    product_cart?: { product_id: string }[];
  };
}

export type DodoResult = { handled: boolean; note: string };

async function workspaceFor(env: Env, d: NonNullable<DodoPayload['data']>): Promise<string | null> {
  const meta = d.metadata?.workspace_id;
  if (meta) {
    const ok = await env.DB.prepare('SELECT id FROM workspaces WHERE id = ?').bind(meta).first();
    if (ok) return meta;
  }
  if (d.subscription_id) {
    const r = await env.DB.prepare('SELECT workspace_id FROM subscriptions WHERE dodo_subscription_id = ?').bind(d.subscription_id).first<{ workspace_id: string }>();
    if (r) return r.workspace_id;
  }
  return null;
}

const planForProduct = (productId?: string): PlanId | null =>
  productId === dodoProducts.products.pro ? 'pro' : productId === dodoProducts.products.max ? 'max' : null;

/** Apply a verified Dodo event to subscriptions + credit_ledger. Idempotent on `webhookId` (ledger.external_event_id). */
export async function applyDodoEvent(env: Env, webhookId: string, p: DodoPayload): Promise<DodoResult> {
  const d = p.data;
  const type = p.type ?? '';
  if (!d) return { handled: false, note: 'no data' };
  const ws = await workspaceFor(env, d);
  if (!ws) return { handled: false, note: 'unknown workspace' };

  if (type.startsWith('subscription.')) {
    const plan = planForProduct(d.product_id) ?? (d.metadata?.plan === 'pro' || d.metadata?.plan === 'max' ? d.metadata.plan : null);
    const status = type === 'subscription.cancelled' || type === 'subscription.expired' || type === 'subscription.failed' ? 'cancelled' : type === 'subscription.on_hold' ? 'on_hold' : 'active';
    const existing = await env.DB.prepare('SELECT plan FROM subscriptions WHERE workspace_id = ?').bind(ws).first<{ plan: PlanId }>();
    // A cancelled or expired subscription falls back to Scout; other states keep or set the paid plan.
    const effective: PlanId = status === 'cancelled' ? 'free' : (plan ?? existing?.plan ?? 'free');
    await env.DB.prepare(
      `INSERT INTO subscriptions (workspace_id, plan, dodo_customer_id, dodo_subscription_id, status, current_period_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(workspace_id) DO UPDATE SET plan = ?2, dodo_customer_id = COALESCE(?3, dodo_customer_id), dodo_subscription_id = COALESCE(?4, dodo_subscription_id), status = ?5, current_period_end = COALESCE(?6, current_period_end)`,
    ).bind(ws, effective, d.customer?.customer_id ?? null, d.subscription_id ?? null, status === 'cancelled' ? 'cancelled' : status, d.next_billing_date ?? null).run();
    let granted = false;
    if ((type === 'subscription.active' || type === 'subscription.renewed') && effective !== 'free') {
      granted = await grantCredits(env, ws, planCredits(effective), `${effective}_plan_grant`, { externalId: webhookId });
    }
    await emit(env, ws, 'billing.updated', { kind: type, plan: effective, status, credits_granted: granted ? planCredits(effective) : 0 });
    return { handled: true, note: `${type} -> ${effective}` };
  }

  if (type === 'payment.succeeded') {
    const isPack = d.metadata?.plan === 'credits' || (d.product_cart ?? []).some((i) => i.product_id === dodoProducts.products.credits);
    if (isPack && !d.subscription_id) {
      const granted = await grantCredits(env, ws, 100, 'credit_pack', { externalId: webhookId, ref: d.payment_id ? `pay:${d.payment_id}` : undefined });
      if (d.customer?.customer_id) {
        await env.DB.prepare('INSERT INTO subscriptions (workspace_id, plan, dodo_customer_id, status) VALUES (?, \'free\', ?, \'active\') ON CONFLICT(workspace_id) DO UPDATE SET dodo_customer_id = COALESCE(dodo_customer_id, excluded.dodo_customer_id)').bind(ws, d.customer.customer_id).run();
      }
      await emit(env, ws, 'billing.updated', { kind: type, credits_granted: granted ? 100 : 0 });
      return { handled: true, note: 'credit pack' };
    }
  }
  return { handled: false, note: `ignored ${type}` };
}
