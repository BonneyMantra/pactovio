import { Hono } from 'hono';
import { handleComposioWebhook } from '@pactovio/connectors';
import type { AppEnv } from '../lib/types';

/** POST /webhooks/composio: Composio trigger deliveries (new Gmail and Outlook mail). Signature-verified in the connectors package. */
export const composioWebhook = new Hono<AppEnv>().post('/webhooks/composio', async (c) => {
  const raw = await c.req.text();
  if (raw.length > 1_000_000) return c.json({ error: 'Payload too large', code: 'validation' }, 413);
  const r = await handleComposioWebhook(c.env, raw, c.req.raw.headers);
  return c.json(r.body, r.status as 200);
});
