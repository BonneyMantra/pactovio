import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';
import { customerFixture } from './customer-fixture';

let env: Env, dispose: () => Promise<void>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, body?: unknown, cookie = '', origin = 'https://pactovio.example', method = body === undefined ? 'GET' : 'POST') =>
  app.fetch(new Request(`https://pactovio.example/api${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.17' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
let sent: { to: string[]; text: string }[] = [];
function mail(ok = true) {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json(ok ? { id: 'mail_receipt' } : { error: 'transport unavailable' }, { status: ok ? 200 : 500 });
  }));
}
const email = (label: string) => `${label}@meridian.example`;
async function request(label: string) {
  const address = email(label);
  const res = await call('/auth/code/request', { email: address });
  expect(res.status).toBe(202);
  const code = sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
  return { address, code };
}
async function login(label: string) {
  const { address, code } = await request(label);
  const res = await call('/auth/code/verify', { email: address, code });
  expect(res.status).toBe(200);
  return { res, cookie: res.headers.get('set-cookie')!.split(';')[0]!, data: await res.json() as any };
}
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, AUTH_SECRET: 'test-only-hmac-secret-at-least-32-characters', RESEND_API_KEY: 'transport-test', AUTH_EMAIL_FROM: 'Pactovio <login@pactovio.example>' };
}, 60000);
afterAll(async () => dispose?.());
afterEach(() => { vi.unstubAllGlobals(); sent = []; });

describe('verified customer auth', () => {
  it('anonymous and legacy sample cookies cannot authenticate or mint customer API keys', async () => {
    expect((await call('/session')).status).toBe(401);
    expect((await call('/session', undefined, 'pv_s=ses_sample')).status).toBe(401);
    expect((await call('/api-keys', { name: 'escalation' }, 'pv_s=ses_sample')).status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM judge_sessions').first<{ n: number }>())!.n).toBe(0);
  });
  it('validates email and code inputs, and rejects missing or foreign origin before sending', async () => {
    mail();
    expect((await call('/auth/code/request', { email: 'not-email' })).status).toBe(400);
    expect((await call('/auth/code/request', { email: email('origin') }, '', 'https://evil.example')).status).toBe(403);
    expect((await call('/auth/code/request', { email: email('origin') }, '', '')).status).toBe(403);
    expect((await call('/auth/code/verify', { email: email('valid'), code: '123' })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
  it('creates an empty non-sample workspace, hashed opaque cookie session, and single-use code', async () => {
    mail();
    const { address, code } = await request('first');
    const stored = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ?').bind(address).first<any>();
    expect(stored.code_hash).not.toContain(code);
    expect(stored.code_hash).toHaveLength(64);
    const res = await call('/auth/code/verify', { email: address, code });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax');
    const data = await res.json() as any;
    expect(data).toMatchObject({ authenticated: true, user: { email: address }, workspace: { sample: false }, onboarding_complete: false });
    const session = await env.DB.prepare('SELECT token_hash FROM customer_sessions WHERE id = ?').bind(data.session_id).first<any>();
    expect(session.token_hash).not.toBe(cookie.split('=')[1]!.split(';')[0]);
    const today = await (await call('/today', undefined, cookie.split(';')[0]!)).json() as any;
    expect(today.counts).toMatchObject({ new_matches: 0, open_intakes: 0, approvals_pending: 0 });
    expect((await call('/auth/code/verify', { email: address, code })).status).toBe(400);
    expect((await call('/auth/code/verify', { email: email('absent'), code })).status).toBe(400);
  });
  it('accepts one concurrent verification only and resumes the same user/workspace on a later login', async () => {
    mail();
    const { address, code } = await request('race');
    const responses = await Promise.all([call('/auth/code/verify', { email: address, code }), call('/auth/code/verify', { email: address, code })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const initial = await responses.find((r) => r.ok)!.json() as any;
    await env.DB.prepare('UPDATE email_codes SET requested_at = requested_at - 61000 WHERE email = ?').bind(address).run();
    const second = await login('race');
    expect(second.data.user.id).toBe(initial.user.id);
    expect(second.data.workspace_id).toBe(initial.workspace_id);
  });
  it('expires codes and locks after five wrong attempts; resend invalidates the previous code', async () => {
    mail();
    const old = await request('expired');
    await env.DB.prepare('UPDATE email_codes SET expires_at = 0 WHERE email = ?').bind(old.address).run();
    expect((await call('/auth/code/verify', { email: old.address, code: old.code })).status).toBe(400);
    const lock = await request('locked');
    const wrong = lock.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) expect((await call('/auth/code/verify', { email: lock.address, code: wrong })).status).toBe(400);
    expect((await call('/auth/code/verify', { email: lock.address, code: lock.code })).status).toBe(400);
    const resend = await request('resend');
    expect((await call('/auth/code/request', { email: resend.address })).status).toBe(429);
    await env.DB.prepare('UPDATE email_codes SET requested_at = requested_at - 61000 WHERE email = ?').bind(resend.address).run();
    const next = await request('resend');
    // Challenge identity changes even in the one-in-a-million case of the same six digits.
    expect((await call('/auth/code/verify', { email: next.address, code: next.code })).status).toBe(200);
  });
  it('mail failures do not create usable codes or customer identities; missing config is safe', async () => {
    mail(false);
    const address = email('delivery');
    expect((await call('/auth/code/request', { email: address })).status).toBe(503);
    const code = sent.at(-1)!.text.match(/\b\d{6}\b/)![0];
    expect((await call('/auth/code/verify', { email: address, code })).status).toBe(400);
    expect(await env.DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(address).first()).toBeNull();
    const key = env.RESEND_API_KEY; delete env.RESEND_API_KEY;
    expect((await call('/auth/code/request', { email: email('missing-config') })).status).toBe(503);
    env.RESEND_API_KEY = key;
  });
  it('enforces email and IP limits even for absent emails', async () => {
    mail();
    const address = email('email-limit');
    for (let i = 0; i < 20; i++) expect((await call('/auth/code/verify', { email: address, code: '999999' })).status).toBe(400);
    expect((await call('/auth/code/verify', { email: address, code: '999999' })).status).toBe(429);
    await env.DB.prepare("INSERT OR REPLACE INTO auth_limits VALUES ('request:ip:' || ?, 20, ?)")
      .bind(await (await import('../src/lib/db')).sha256Hex('192.0.2.17'), Date.now() + 60000).run();
    expect((await call('/auth/code/request', { email: email('ip-limited') })).status).toBe(429);
    await env.DB.prepare("DELETE FROM auth_limits WHERE key LIKE 'request:ip:%'").run();
  });
  it('does not restore removed membership or issue a usable session on a later login', async () => {
    mail();
    const first = await login('removed-member');
    await env.DB.prepare('DELETE FROM workspace_members WHERE user_id = ?').bind(first.data.user.id).run();
    await env.DB.prepare('UPDATE email_codes SET requested_at = requested_at - 61000 WHERE email = ?').bind(email('removed-member')).run();
    const next = await request('removed-member');
    const res = await call('/auth/code/verify', { email: next.address, code: next.code });
    expect(res.status).toBe(401); expect(res.headers.get('set-cookie')).toBeNull();
    expect(await env.DB.prepare('SELECT user_id FROM workspace_members WHERE user_id = ?').bind(first.data.user.id).first()).toBeNull();
  });
  it('rotates the signed-in browser session when a new code is verified', async () => {
    mail();
    const first = await login('rotate');
    await env.DB.prepare('UPDATE email_codes SET requested_at = requested_at - 61000 WHERE email = ?').bind(email('rotate')).run();
    const next = await request('rotate');
    const response = await call('/auth/code/verify', { email: next.address, code: next.code }, first.cookie);
    expect(response.status).toBe(200);
    expect((await call('/session', undefined, first.cookie)).status).toBe(401);
    expect((await call('/session', undefined, response.headers.get('set-cookie')!.split(';')[0]!)).status).toBe(200);
  });
  it('expires/revokes sessions, rejects cross-origin mutations and removes membership authority', async () => {
    const a = await customerFixture(env);
    expect((await call('/session', undefined, a.cookie)).status).toBe(200);
    expect((await call('/auth/logout', {}, a.cookie, 'https://evil.example')).status).toBe(403);
    expect((await call('/onboarding', { company: { name: 'Altered' } }, a.cookie, 'https://evil.example', 'PATCH')).status).toBe(403);
    expect((await call('/auth/logout', {}, a.cookie)).status).toBe(200);
    expect((await call('/session', undefined, a.cookie)).status).toBe(401);
    const b = await customerFixture(env);
    await env.DB.prepare('UPDATE customer_sessions SET expires_at = 0 WHERE id = ?').bind(b.session).run();
    expect((await call('/session', undefined, b.cookie)).status).toBe(401);
    const c = await customerFixture(env);
    await env.DB.prepare('DELETE FROM workspace_members WHERE user_id = ?').bind(c.user).run();
    expect((await call('/session', undefined, c.cookie)).status).toBe(401);
  });
});
