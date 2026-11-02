import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { applyDodoEvent, chargeCredits, getPlan, reserveRun, reserveTavily, standardSign, verifyStandardWebhook, dodoProducts } from '@pactovio/billing';
import { deriveWebhookSecret, verifyWebhook } from '@pactovio/events';
import { buildApp } from '../src/app';
import { fanOut, wants } from '../src/queue';
import { buildIcs, esc } from '../src/routes/ics';
import { assertWebhookUrl } from '../src/routes/webhooks';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
let customerCookie = '';
const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { cookie: customerCookie, origin: 'http://localhost', ...(init.headers as Record<string, string>) } }), env, ctx);
const WS = 'ws_f_real';
const SECRET = 'whsec_' + btoa('lane-f-test-secret-0123456789abcdef');

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env.DODO_WEBHOOK_SECRET = SECRET;
  customerCookie = (await customerFixture(env, 'ws_kestrel_sensing')).cookie;
  await env.DB.prepare("INSERT INTO workspaces (id, name, segment, sample, created_at) VALUES (?, 'Real Co', 'it', 0, ?)").bind(WS, new Date().toISOString()).run();
}, 60_000);
afterAll(async () => dispose?.());

describe('Standard Webhooks (Dodo)', () => {
  const body = '{"type":"x"}';
  const ts = () => String(Math.floor(Date.now() / 1000));
  it('accepts a valid signature, including one of several', async () => {
    const t = ts();
    const sig = await standardSign(SECRET, 'msg_1', t, body);
    expect(await verifyStandardWebhook(SECRET, { id: 'msg_1', timestamp: t, signature: sig }, body)).toBe(true);
    expect(await verifyStandardWebhook(SECRET, { id: 'msg_1', timestamp: t, signature: `v1,AAAA ${sig}` }, body)).toBe(true);
  });
  it('rejects tampered body, wrong id, wrong secret, stale timestamp, missing headers', async () => {
    const t = ts();
    const sig = await standardSign(SECRET, 'msg_1', t, body);
    expect(await verifyStandardWebhook(SECRET, { id: 'msg_1', timestamp: t, signature: sig }, body + ' ')).toBe(false);
    expect(await verifyStandardWebhook(SECRET, { id: 'msg_2', timestamp: t, signature: sig }, body)).toBe(false);
    expect(await verifyStandardWebhook('whsec_' + btoa('other-secret-other-secret-xx'), { id: 'msg_1', timestamp: t, signature: sig }, body)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(await verifyStandardWebhook(SECRET, { id: 'msg_1', timestamp: old, signature: await standardSign(SECRET, 'msg_1', old, body) }, body)).toBe(false);
    expect(await verifyStandardWebhook(SECRET, { id: null, timestamp: t, signature: sig }, body)).toBe(false);
  });
  it('POST /webhooks/dodo: 401 unsigned, 200 signed, idempotent on webhook-id', async () => {
    const payload = JSON.stringify({ type: 'subscription.active', data: { subscription_id: 'sub_t1', product_id: dodoProducts.products.pro, customer: { customer_id: 'cus_t1' }, metadata: { workspace_id: WS, plan: 'pro' }, next_billing_date: '2026-12-01T00:00:00Z' } });
    expect((await call('/webhooks/dodo', { method: 'POST', body: payload })).status).toBe(401);
    const send = async () => {
      const t = ts();
      return call('/webhooks/dodo', { method: 'POST', body: payload, headers: { 'webhook-id': 'wh_evt_1', 'webhook-timestamp': t, 'webhook-signature': await standardSign(SECRET, 'wh_evt_1', t, payload) } });
    };
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const p = await getPlan(env, WS);
    expect(p.plan).toBe('pro');
    expect(p.creditsBalance).toBe(150); // one grant despite two deliveries
  });
});

describe('credit ledger', () => {
  it('charges once per ref and returns the balance', async () => {
    const a = await chargeCredits(env, WS, 2, 'pack_read_medium', 'run_a');
    const b = await chargeCredits(env, WS, 2, 'pack_read_medium', 'run_a');
    expect(a).toBe(148);
    expect(b).toBe(148);
  });
  it('refuses with 402 when the balance is too low and writes nothing', async () => {
    await expect(chargeCredits(env, WS, 500, 'x', 'run_big')).rejects.toMatchObject({ status: 402, code: 'insufficient_credits' });
    expect((await getPlan(env, WS)).creditsBalance).toBe(148);
  });
  it('rejects non-positive credits', async () => {
    await expect(chargeCredits(env, WS, 0, 'x', 'r0')).rejects.toMatchObject({ status: 400 });
  });
  it('never charges shared sample workspaces', async () => {
    const before = (await getPlan(env, 'ws_harbour_digital')).creditsBalance;
    expect(await chargeCredits(env, 'ws_harbour_digital', 4, 'pack_read_large', 'run_s')).toBe(before);
  });
  it('Scout (free) real workspace gets 3 credits a month, then 402', async () => {
    const ws = 'ws_f_scout';
    await env.DB.prepare("INSERT INTO workspaces (id, name, segment, sample, created_at) VALUES (?, 'Scout Co', 'it', 0, ?)").bind(ws, new Date().toISOString()).run();
    expect((await getPlan(env, ws)).creditsBalance).toBe(3);
    await chargeCredits(env, ws, 1, 'pack_read_small', 's1');
    await chargeCredits(env, ws, 1, 'pack_read_small', 's2');
    await chargeCredits(env, ws, 1, 'pack_read_small', 's3');
    await expect(chargeCredits(env, ws, 1, 'pack_read_small', 's4')).rejects.toMatchObject({ status: 402 });
  });
  it('credit pack payment grants 100 once; cancellation drops to Scout', async () => {
    const pay = { type: 'payment.succeeded', data: { payment_id: 'pay_1', customer: { customer_id: 'cus_t1' }, metadata: { workspace_id: WS, plan: 'credits' } } };
    await applyDodoEvent(env, 'wh_pack', pay);
    await applyDodoEvent(env, 'wh_pack', pay);
    expect((await getPlan(env, WS)).creditsBalance).toBe(248);
    await applyDodoEvent(env, 'wh_cancel', { type: 'subscription.cancelled', data: { subscription_id: 'sub_t1', customer: { customer_id: 'cus_t1' } } });
    expect((await getPlan(env, WS)).plan).toBe('free');
  });
  it('ignores events for unknown workspaces', async () => {
    const r = await applyDodoEvent(env, 'wh_x', { type: 'subscription.active', data: { subscription_id: 'sub_none', metadata: { workspace_id: 'ws_missing' } } });
    expect(r.handled).toBe(false);
  });
});

describe('caps', () => {
  it('judge session: 2 fresh runs, 3 Tavily refreshes', async () => {
    const s = 'ses_f_caps';
    await env.DB.prepare("INSERT INTO judge_sessions (id, workspace_id, created_at) VALUES (?, 'ws_harbour_digital', ?)").bind(s, new Date().toISOString()).run();
    await reserveRun(env, s); await reserveRun(env, s);
    await expect(reserveRun(env, s)).rejects.toMatchObject({ status: 429, code: 'cap_session' });
    for (let i = 0; i < 3; i++) await reserveTavily(env, s);
    await expect(reserveTavily(env, s)).rejects.toMatchObject({ status: 429, code: 'cap_session' });
  });
  it('month budget of 150 stops Tavily and refunds the session slot', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare('INSERT INTO limits_counters (key, day, count) VALUES (?, ?, 150) ON CONFLICT(key, day) DO UPDATE SET count = 150').bind('tavily', `${month}-01`).run();
    const s = 'ses_f_caps2';
    await env.DB.prepare("INSERT INTO judge_sessions (id, workspace_id, created_at) VALUES (?, 'ws_harbour_digital', ?)").bind(s, new Date().toISOString()).run();
    await expect(reserveTavily(env, s)).rejects.toMatchObject({ code: 'cap_month' });
    const row = await env.DB.prepare('SELECT tavily_used FROM judge_sessions WHERE id = ?').bind(s).first<{ tavily_used: number }>();
    expect(row?.tavily_used).toBe(0);
  });
  it('GET /api/limits returns real structure', async () => {
    const res = await call('/api/limits');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { tavily: { month_budget: number }; usage: { prices_are_estimates: boolean }; inference: { rpm: number } };
    expect(j.tavily.month_budget).toBe(150);
    expect(j.inference.rpm).toBe(1000);
    expect(typeof j.usage.prices_are_estimates).toBe('boolean');
  });
});

describe('outgoing webhooks and queue fan-out', () => {
  const event = { id: 'evt_t1', workspace_id: WS, type: 'verdict.ready' as const, payload: { tender_id: 'tnd_1' }, at: new Date().toISOString() };
  it('wants() filters by type; empty list means all', () => {
    expect(wants('[]', 'run.step')).toBe(true);
    expect(wants('["verdict.ready"]', 'run.step')).toBe(false);
    expect(wants('["verdict.ready"]', 'verdict.ready')).toBe(true);
    expect(wants('not json', 'x')).toBe(false);
  });
  it('signs, retries a failing endpoint, never resends to a delivered one', async () => {
    const good = 'whk_good', bad = 'whk_bad';
    for (const [id, url] of [[good, 'https://good.example.com/hook'], [bad, 'https://bad.example.com/hook']] as const) {
      await env.DB.prepare("INSERT INTO webhook_endpoints (id, workspace_id, url, secret_hash, events_json, active) VALUES (?, ?, ?, 'h', '[]', 1)").bind(id, WS, url).run();
    }
    const calls: Record<string, number> = { good: 0, bad: 0 };
    let badOk = false;
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const key = url.includes('good') ? 'good' : 'bad';
      calls[key]!++;
      const hdr = (init?.headers as Record<string, string>)['x-pactovio-signature']!;
      const secret = await deriveWebhookSecret(env, key === 'good' ? good : bad);
      expect(await verifyWebhook(secret, init!.body as string, hdr)).toBe(true);
      return new Response(null, { status: key === 'good' || badOk ? 200 : 500 });
    });
    expect(await fanOut(env, event, 1)).toBe(false);
    badOk = true;
    expect(await fanOut(env, event, 2)).toBe(true);
    f.mockRestore();
    expect(calls).toEqual({ good: 1, bad: 2 });
    const log = await env.DB.prepare('SELECT endpoint_id, status, attempts FROM webhook_deliveries WHERE event = ? ORDER BY endpoint_id').bind('verdict.ready').all<{ endpoint_id: string; status: string; attempts: number }>();
    expect(log.results.map((r) => `${r.endpoint_id}:${r.status}:${r.attempts}`)).toEqual(['whk_bad:delivered:2', 'whk_good:delivered:1']);
  });
  it('marks failed on the last attempt', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    expect(await fanOut(env, { ...event, id: 'evt_t2' }, 4)).toBe(false);
    f.mockRestore();
    const r = await env.DB.prepare("SELECT status FROM webhook_deliveries WHERE id = 'dlv_evt_t2_whk_bad'").first<{ status: string }>();
    expect(r?.status).toBe('failed');
  });
  it('rejects SSRF-prone webhook URLs', () => {
    for (const u of ['http://example.com/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://169.254.169.254/x', 'https://u:p@example.com/x', 'https://intranet/x', 'nonsense'])
      expect(() => assertWebhookUrl(u, false), u).toThrow();
    expect(() => assertWebhookUrl('https://hooks.example.com/x', false)).not.toThrow();
    expect(() => assertWebhookUrl('http://localhost:9/x', true)).not.toThrow();
  });
});

describe('API keys', () => {
  it('creates a hashed key shown once, authenticates /v1, and revoke kills it', async () => {
    const created = await call('/api/api-keys', { method: 'POST', body: JSON.stringify({ name: 'ci' }), headers: { 'content-type': 'application/json' } });
    const { id, key } = (await created.json()) as { id: string; key: string };
    expect(key.startsWith('pk_')).toBe(true);
    const cookie = customerCookie;
    const listed = JSON.stringify(await (await call('/api/api-keys', { headers: { cookie } })).json());
    expect(listed).not.toContain(key);
    expect((await call('/v1/limits', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await call('/v1/limits')).status).toBe(401);
    await call(`/api/api-keys/${id}`, { method: 'DELETE', headers: { cookie } });
    expect((await call('/v1/limits', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });
});

describe('ICS', () => {
  it('builds a valid RFC 5545 calendar with deadlines and clarification dates', () => {
    const ics = buildIcs([{ id: 'tnd_1', title: 'Web apps; maintenance, 3 lots', buyer: 'Teagasc', deadline: '2026-11-19T14:00:00Z', url: null, fit_score: 82.4, raw: { queries_close: '2026-11-05T14:00:00Z' } }], new Date('2026-10-30T00:00:00Z'));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(ics.match(/END:VEVENT/g)!.length);
    expect(ics).toContain('DTSTART:20261119T133000Z');
    expect(ics).toContain('DTEND:20261105T140000Z');
    expect(ics).toContain('Web apps\\; maintenance\\, 3 lots');
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(new Set(ics.match(/UID:[^\r]+/g)).size).toBe(2);
  });
  it('escapes backslash, semicolon, comma and newline', () => expect(esc('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne'));
  it('serves /ics/:token.ics from GET /api/ics and 404s unknown or malformed tokens', async () => {
    const info = await call('/api/ics');
    const { token } = (await info.json()) as { token: string };
    const feed = await call(`/ics/${token}.ics`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
    expect((await feed.text()).match(/BEGIN:VEVENT/g)!.length).toBeGreaterThan(0);
    expect((await call(`/ics/${'0'.repeat(32)}.ics`)).status).toBe(404);
    expect((await call('/ics/..%2Fx.ics')).status).toBe(404);
  });
});

describe('SSE', () => {
  it('GET /api/events with Accept: text/event-stream streams events', async () => {
    await env.DB.prepare("INSERT INTO events (id, workspace_id, type, payload_json, at) VALUES ('evt_sse1', 'ws_kestrel_sensing', 'tender.matched', '{}', ?)").bind(new Date().toISOString()).run();
    const res = await call('/api/events', { headers: { accept: 'text/event-stream' } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('event: ');
    await reader.cancel();
  });
});
