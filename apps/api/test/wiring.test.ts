import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balance, grantCredits } from '@pactovio/billing';
import type { Env } from '@pactovio/contracts/env';
import { startPackRunImpl } from '../../../packages/engine/src/start';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const REAL = 'ws_wiring_real';
const TEAGASC = 'tnd_sample_teagasc_p4941';
const created: string[] = [];
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

beforeAll(async () => {
  const m = await makeEnv();
  dispose = m.dispose;
  env = { ...m.env, PACK_RUN: { create: async (o: { id: string }) => { created.push(o.id); return {} as never; } } as unknown as Workflow };
  await env.DB.prepare("INSERT INTO workspaces (id, name, segment, sample, created_at) VALUES (?, 'Real Co', 'it', 0, ?)").bind(REAL, new Date().toISOString()).run();
}, 60_000);
afterAll(async () => dispose?.());

describe('billing is wired into fresh pack runs', () => {
  it('a real workspace with no credits gets 402 and nothing is left behind; with credits the run is charged by pack size and refunded if the workflow cannot start', async () => {
    await env.DB.prepare("DELETE FROM credit_ledger WHERE workspace_id = ?").bind(REAL).run();
    await grantCredits(env, REAL, 0, 'noop', { ref: 'noop' }); // no balance
    // free plan lazily grants the monthly Scout credits (3); spend them first
    await expect(startPackRunImpl(env, { workspaceId: REAL, tenderId: TEAGASC, replay: false })).resolves.toMatch(/^run_/);
    const after = await balance(env, REAL);
    expect(after).toBeLessThan(3); // charged
    await env.DB.prepare("UPDATE runs SET status = 'completed'").run();
    const broken = { ...env, PACK_RUN: { create: async () => { throw new Error('down'); } } as unknown as Workflow } as Env;
    await expect(startPackRunImpl(broken, { workspaceId: REAL, tenderId: TEAGASC, replay: false })).rejects.toMatchObject({ status: 502 });
    expect(await balance(env, REAL)).toBe(after); // refunded
    await env.DB.prepare("DELETE FROM credit_ledger WHERE workspace_id = ? AND reason NOT LIKE 'scout%'").bind(REAL).run();
    await env.DB.prepare("INSERT INTO credit_ledger (id, workspace_id, delta, reason, ref, at) VALUES ('led_drain', ?, ?, 'drain', 'drain', ?)").bind(REAL, -(await balance(env, REAL)), new Date().toISOString()).run();
    await env.DB.prepare("UPDATE runs SET status = 'completed'").run();
    await expect(startPackRunImpl(env, { workspaceId: REAL, tenderId: TEAGASC, replay: false })).rejects.toMatchObject({ status: 402, code: 'insufficient_credits' });
  });

  it('sample workspaces are never charged', async () => {
    await env.DB.prepare("UPDATE runs SET status = 'completed'").run();
    const before = await balance(env, 'ws_harbour_digital');
    await startPackRunImpl(env, { workspaceId: 'ws_harbour_digital', tenderId: TEAGASC, replay: false });
    expect(await balance(env, 'ws_harbour_digital')).toBe(before);
  });
});

describe('tender list', () => {
  it('hides dismissed matches unless asked for explicitly', async () => {
    const cookie = await sessionCookie();
    const get = async (q: string) => ((await (await app.fetch(new Request(`http://localhost/api/tenders${q}`, { headers: { cookie } }), env, ctx)).json()) as { items: { match: { status: string } | null }[] }).items;
    await env.DB.prepare("UPDATE tender_matches SET status = 'dismissed' WHERE workspace_id = 'ws_harbour_digital' AND tender_id = ?").bind(TEAGASC).run();
    const visible = await get('');
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((i) => i.match?.status !== 'dismissed')).toBe(true);
    expect((await get('?status=dismissed')).length).toBe(1);
  });
});

describe('agent message rate limit at the route', () => {
  it('the 11th message in a minute from one judge session is 429 cap_rate', async () => {
    const cookie = await sessionCookie();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // the Durable Object is not available under the test proxy, so the first ten pass the limiter and fail at the hub (not 429)
      const res = await app.fetch(new Request('http://localhost/api/agent/messages', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"content":"hello"}' }), env, ctx);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

async function sessionCookie(): Promise<string> {
  const res = await app.fetch(new Request('http://localhost/api/workspaces'), env, ctx);
  const set = res.headers.get('set-cookie') ?? '';
  return set.split(';')[0] ?? '';
}
