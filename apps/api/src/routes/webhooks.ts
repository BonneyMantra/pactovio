import { endpoints, HttpError, newId, type WebhookDelivery, type WebhookEndpoint } from '@pactovio/contracts';
import { deriveWebhookSecret } from '@pactovio/events';
import { exec, one, rows, sha256Hex } from '../lib/db';
import type { Register } from '../lib/router';

/** Outgoing webhook targets must be public https URLs (SSRF guard); http://localhost is allowed only in development. */
export function assertWebhookUrl(raw: string, dev: boolean): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'Invalid webhook URL', 'validation'); }
  const h = u.hostname.toLowerCase();
  if (dev && u.protocol === 'http:' && (h === 'localhost' || h === '127.0.0.1')) return;
  const priv = h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') || h.startsWith('[')
    || /^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (u.protocol !== 'https:' || priv || u.username || u.password) throw new HttpError(400, 'Webhook URL must be a public https URL', 'validation');
}

export const register: Register = (r) => {
  r.on(endpoints.listWebhooks, async ({ db, workspaceId }) => ({
    items: await rows<WebhookEndpoint>(db, 'SELECT id, workspace_id, url, events_json, active FROM webhook_endpoints WHERE workspace_id = ? ORDER BY id', workspaceId),
  }));
  r.on(endpoints.createWebhook, async ({ env, db, workspaceId, body }) => {
    assertWebhookUrl(body.url, env.ENVIRONMENT === 'development');
    const id = newId('webhook');
    const secret = await deriveWebhookSecret(env, id);
    await exec(db, 'INSERT INTO webhook_endpoints (id, workspace_id, url, secret_hash, events_json, active) VALUES (?, ?, ?, ?, ?, 1)', id, workspaceId, body.url, await sha256Hex(secret), JSON.stringify(body.events));
    return { id, url: body.url, events: body.events, secret };
  });
  r.on(endpoints.deleteWebhook, async ({ db, workspaceId, params }) => {
    const e = await one(db, 'SELECT id FROM webhook_endpoints WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!e) throw new HttpError(404, 'Webhook not found', 'not_found');
    await exec(db, 'DELETE FROM webhook_deliveries WHERE endpoint_id = ?', params.id);
    await exec(db, 'DELETE FROM webhook_endpoints WHERE id = ?', params.id);
    return { ok: true };
  });
  r.on(endpoints.listWebhookDeliveries, async ({ db, workspaceId, params }) => {
    const e = await one(db, 'SELECT id FROM webhook_endpoints WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!e) throw new HttpError(404, 'Webhook not found', 'not_found');
    return { items: await rows<WebhookDelivery>(db, 'SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY at DESC LIMIT 100', params.id) };
  });
};
