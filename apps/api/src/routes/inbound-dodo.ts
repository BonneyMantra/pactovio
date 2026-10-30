import { Hono } from 'hono';
import { applyDodoEvent, verifyStandardWebhook } from '@pactovio/billing';
import type { AppEnv } from '../lib/types';

/** POST /webhooks/dodo: Standard Webhooks signature (DODO_WEBHOOK_SECRET), then subscriptions + credit_ledger (idempotent on webhook-id). */
export const dodoWebhook = new Hono<AppEnv>().post('/webhooks/dodo', async (c) => {
  const secret = c.env.DODO_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'Webhook not configured', code: 'not_configured' }, 500);
  const body = await c.req.text();
  const id = c.req.header('webhook-id');
  const ok = await verifyStandardWebhook(secret, { id, timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') }, body);
  if (!ok || !id) return c.json({ error: 'Invalid signature', code: 'unauthorized' }, 401);
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return c.json({ error: 'Invalid JSON', code: 'validation' }, 400); }
  try {
    const r = await applyDodoEvent(c.env, id, payload as Parameters<typeof applyDodoEvent>[2]);
    return c.json({ ok: true, ...r });
  } catch (e) {
    console.error('dodo webhook failed', e instanceof Error ? e.message : 'unknown');
    return c.json({ error: 'Processing failed', code: 'internal' }, 500); // Dodo retries
  }
});
