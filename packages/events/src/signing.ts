import type { Env } from '@pactovio/contracts/env';

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

/**
 * Per-endpoint signing secret, derived (not stored): HMAC(WEBHOOK_SIGNING_SECRET, endpointId).
 * Shown to the user once at creation; `webhook_endpoints.secret_hash` holds only its SHA-256.
 */
export async function deriveWebhookSecret(env: Pick<Env, 'WEBHOOK_SIGNING_SECRET' | 'ENVIRONMENT'>, endpointId: string): Promise<string> {
  const root = env.WEBHOOK_SIGNING_SECRET ?? (env.ENVIRONMENT === 'development' ? 'dev-webhook-signing' : undefined);
  if (!root) throw new Error('WEBHOOK_SIGNING_SECRET is not configured');
  return `whsec_${(await hmac(root, endpointId)).slice(0, 40)}`;
}

/** `X-Pactovio-Signature: t=<unix>,v1=<HMAC-SHA256(secret, `${t}.${body}`)>` */
export async function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmac(secret, `${t}.${body}`)}`;
}

export async function verifyWebhook(secret: string, body: string, header: string, toleranceSec = 300): Promise<boolean> {
  const m = /t=(\d+),v1=([a-f0-9]+)/.exec(header);
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  return (await signWebhook(secret, body, Number(m[1]))) === `t=${m[1]},v1=${m[2]}`;
}
