import type { Context } from 'hono';
import { HttpError } from '@pactovio/contracts';
import type { AppEnv } from './types';

/** Require an explicit same-origin browser mutation, including login (prevents login CSRF). */
export function sameOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header('origin');
  const expected = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  if (c.req.header('sec-fetch-site') === 'cross-site' || !origin || origin !== expected) {
    throw new HttpError(403, 'A same-origin request is required', 'origin_forbidden');
  }
}

export async function codeHash(c: Context<AppEnv>, email: string, challenge: string, code: string): Promise<string> {
  const secret = c.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, 'Email sign-in is not configured', 'auth_unavailable');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${email}\n${challenge}\n${code}`));
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}

export function sixDigits(): string {
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0]! >= 4294000000);
  return String(value[0]! % 1000000).padStart(6, '0');
}

/** Atomic fixed-window counter. Denied requests never extend the window. */
export async function takeLimit(db: D1Database, key: string, max: number, seconds: number): Promise<void> {
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO auth_limits (key, count, resets_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN resets_at <= ? THEN 1 ELSE count + 1 END,
    resets_at = CASE WHEN resets_at <= ? THEN excluded.resets_at ELSE resets_at END
    WHERE resets_at <= ? OR count < ? RETURNING count`).bind(key, now + seconds * 1000, now, now, now, max).first();
  if (!row) throw new HttpError(429, 'Too many attempts; try again later', 'rate_limited');
}
