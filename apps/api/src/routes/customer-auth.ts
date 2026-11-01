import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { HttpError, RequestCode, VerifyCode } from '@pactovio/contracts';
import { exec, randomToken, sha256Hex } from '../lib/db';
import { codeHash, sameOrigin, sixDigits, takeLimit } from '../lib/customer-security';
import { createCustomerSession, CUSTOMER_COOKIE, customerCookie, sessionInfo } from '../lib/customer-session';
import type { AppEnv } from '../lib/types';

export const customerAuthRoutes = new Hono<AppEnv>();
customerAuthRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  sameOrigin(c);
  await next();
});

async function limits(c: Parameters<typeof sameOrigin>[0], email: string, purpose: 'request' | 'verify') {
  // CF-Connecting-IP is set by the edge. Never trust client-controlled X-Forwarded-For.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  await takeLimit(c.env.DB, `${purpose}:ip:${await sha256Hex(ip)}`, purpose === 'request' ? 20 : 100, 3600);
  await takeLimit(c.env.DB, `${purpose}:email:${await sha256Hex(email)}`, purpose === 'request' ? 5 : 20, 3600);
}

customerAuthRoutes.post('/code/request', async (c) => {
  const { email } = RequestCode.parse(await c.req.json().catch(() => ({})));
  await limits(c, email, 'request');
  const code = sixDigits(), challenge = randomToken(24), now = Date.now();
  const hash = await codeHash(c, email, challenge, code);
  if (!c.env.RESEND_API_KEY || !c.env.AUTH_EMAIL_FROM) throw new HttpError(503, 'Email sign-in is not configured', 'auth_unavailable');
  const claimed = await c.env.DB.prepare(`INSERT INTO email_codes (email, challenge, code_hash, requested_at, expires_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET challenge = excluded.challenge,
    code_hash = excluded.code_hash, requested_at = excluded.requested_at, expires_at = excluded.expires_at,
    attempts = 0, delivered = 0, consumed_at = NULL WHERE requested_at <= ? RETURNING challenge`)
    .bind(email, challenge, hash, now, now + 600000, now - 60000).first();
  if (!claimed) throw new HttpError(429, 'Wait 60 seconds before requesting another code', 'rate_limited');
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `login-${challenge}` },
      body: JSON.stringify({ from: c.env.AUTH_EMAIL_FROM, to: [email], subject: 'Your Pactovio sign-in code',
        text: `Your Pactovio sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, ignore this email.` }),
    });
    if (!response.ok) throw new Error('delivery failed');
    const receipt = await response.json() as { id?: unknown };
    if (typeof receipt.id !== 'string') throw new Error('delivery failed');
    await exec(c.env.DB, 'UPDATE email_codes SET delivered = 1 WHERE email = ? AND challenge = ? AND consumed_at IS NULL', email, challenge);
  } catch {
    await exec(c.env.DB, 'UPDATE email_codes SET consumed_at = ? WHERE email = ? AND challenge = ?', now, email, challenge);
    throw new HttpError(503, 'Unable to deliver a code; try again later', 'delivery_unavailable');
  }
  return c.json({ ok: true, retry_after: 60, expires_in: 600 }, 202);
});

customerAuthRoutes.post('/code/verify', async (c) => {
  const { email, code } = VerifyCode.parse(await c.req.json().catch(() => ({})));
  await limits(c, email, 'verify');
  const db = c.env.DB, now = Date.now();
  // Increment every attempt atomically before checking the code. Only five attempts per challenge.
  const row = await db.prepare(`UPDATE email_codes SET attempts = attempts + 1
    WHERE email = ? AND delivered = 1 AND consumed_at IS NULL AND expires_at > ? AND attempts < 5
    RETURNING challenge`).bind(email, now).first<{ challenge: string }>();
  const hash = await codeHash(c, email, row?.challenge ?? 'missing', code);
  const consumed = row && await db.prepare(`UPDATE email_codes SET consumed_at = ? WHERE email = ? AND challenge = ?
    AND code_hash = ? AND delivered = 1 AND consumed_at IS NULL AND expires_at > ? RETURNING email`)
    .bind(now, email, row.challenge, hash, now).first();
  if (!consumed) throw new HttpError(400, 'Invalid or expired code', 'invalid_code');
  const auth = await createCustomerSession(c, email);
  // Rotate/revoke the previous browser session after successful authentication.
  const old = getCookie(c, CUSTOMER_COOKIE);
  if (old) await exec(db, 'UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ?', now, await sha256Hex(old));
  return c.json(await sessionInfo(db, auth));
});

customerAuthRoutes.post('/logout', async (c) => {
  const token = getCookie(c, CUSTOMER_COOKIE);
  if (token) await exec(c.env.DB, 'UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ?', Date.now(), await sha256Hex(token));
  customerCookie(c, '', 0);
  return c.json({ ok: true });
});
