/**
 * Composio webhook verification (docs: "Verifying signatures"). Every delivery carries
 * `webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,<base64 HMAC-SHA256>`, space-separated when rotated).
 * HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{rawBody}` keyed with the project's webhook subscription secret.
 * Replays older than 300 s are rejected.
 */
export const TOLERANCE_SECONDS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' | 'no_secret' };

const enc = new TextEncoder();

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const b64encode = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

async function hmac(key: Uint8Array, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64encode(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyComposioWebhook(
  secret: string | undefined,
  headers: { get(name: string): string | null },
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: 'no_secret' };
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sig = headers.get('webhook-signature');
  if (!id || !ts || !sig) return { ok: false, reason: 'missing_headers' };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const keys: Uint8Array[] = [enc.encode(secret)];
  if (secret.startsWith('whsec_')) {
    try { keys.push(b64decode(secret.slice(6))); } catch { /* not base64: raw key only */ }
  }
  const received = sig.split(' ').map((p) => (p.includes(',') ? p.slice(p.indexOf(',') + 1) : p));
  const signed = `${id}.${ts}.${rawBody}`;
  for (const key of keys) {
    const expected = await hmac(key, signed);
    if (received.some((r) => safeEqual(r, expected))) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

/** Test/e2e helper: sign a body the way Composio does. */
export async function signComposioWebhook(secret: string, id: string, timestamp: number, rawBody: string): Promise<string> {
  return `v1,${await hmac(enc.encode(secret), `${id}.${timestamp}.${rawBody}`)}`;
}
