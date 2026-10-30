import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { buyerIntelImpl, CAPS, consumeFreshRun, consumeTavilyCall, consumeTavilyRefresh } from '@pactovio/engine';
import { startPackRunImpl } from '../../../packages/engine/src/start';
import { makeEnv } from './helpers';

const HARBOUR = 'ws_harbour_digital';
const TEAGASC = 'tnd_sample_teagasc_p4941';
let env: Env;
let dispose: () => Promise<void>;
let created: { id: string; params: unknown }[] = [];

beforeAll(async () => {
  const m = await makeEnv();
  dispose = m.dispose;
  // the local platform proxy has no Workflows runtime: a recording fake stands in for PACK_RUN
  env = { ...m.env, PACK_RUN: { create: async (o: { id: string; params: unknown }) => { created.push(o); return {} as never; } } as unknown as Workflow };
});
afterAll(async () => dispose());

async function session(): Promise<string> {
  const id = newId('session');
  await env.DB.prepare('INSERT INTO judge_sessions (id, workspace_id, created_at) VALUES (?, ?, ?)').bind(id, HARBOUR, new Date().toISOString()).run();
  return id;
}
const used = async (id: string) => (await env.DB.prepare('SELECT runs_used, tavily_used FROM judge_sessions WHERE id = ?').bind(id).first<{ runs_used: number; tavily_used: number }>())!;
const finishAll = () => env.DB.prepare("UPDATE runs SET status = 'completed' WHERE status IN ('queued','running')").run();

describe('judge caps: fresh pack runs', () => {
  it('allows exactly 2 fresh runs per session, the third is a 429 cap_session', async () => {
    const s = await session();
    await startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s });
    await finishAll();
    await startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s });
    await finishAll();
    await expect(startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s })).rejects.toMatchObject({ status: 429, code: 'cap_session' });
    expect((await used(s)).runs_used).toBe(CAPS.freshRuns);
    // a refused run leaves no run row behind
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('replays never count against the cap, however many are played', async () => {
    const s = await session();
    const before = created.length;
    for (let i = 0; i < 4; i++) {
      const id = await startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s, replay: true });
      expect(id).toMatch(/^run_/);
      await finishAll();
    }
    expect((await used(s)).runs_used).toBe(0);
    expect(created.length - before).toBe(4);
    const row = await env.DB.prepare('SELECT replay FROM runs WHERE id = ?').bind((created.at(-1) as { id: string }).id).first<{ replay: number }>();
    expect(row!.replay).toBe(1);
  });

  it('a replay for a workspace with no recording is a 404, not an empty run', async () => {
    await expect(startPackRunImpl(env, { workspaceId: 'ws_kestrel_sensing', tenderId: TEAGASC, replay: true })).rejects.toMatchObject({ status: 404 });
  });

  it('refunds the cap when the workflow cannot be started', async () => {
    const s = await session();
    const broken = { ...env, PACK_RUN: { create: async () => { throw new Error('binding down'); } } as unknown as Workflow } as Env;
    await expect(startPackRunImpl(broken, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s })).rejects.toMatchObject({ status: 502 });
    expect((await used(s)).runs_used).toBe(0);
  });

  it('refuses a second run while one is in progress (409) without spending the cap', async () => {
    await finishAll();
    const s = await session();
    await startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s });
    await expect(startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: TEAGASC, sessionId: s })).rejects.toMatchObject({ status: 409 });
    expect((await used(s)).runs_used).toBe(1);
    await finishAll();
  });

  it('API-key calls (no session) are not judge-capped', async () => {
    await consumeFreshRun(env.DB, null);
    await expect(consumeFreshRun(env.DB, undefined)).resolves.toBeUndefined();
  });

  it('unknown tender and workspace are 404', async () => {
    await expect(startPackRunImpl(env, { workspaceId: HARBOUR, tenderId: 'tnd_nope' })).rejects.toBeInstanceOf(HttpError);
    await expect(startPackRunImpl(env, { workspaceId: 'ws_nope', tenderId: TEAGASC })).rejects.toMatchObject({ status: 404 });
  });
});

describe('caps: Tavily', () => {
  it('3 buyer refreshes per session', async () => {
    const s = await session();
    for (let i = 1; i <= CAPS.tavilyRefreshes; i++) expect(await consumeTavilyRefresh(env.DB, s)).toBe(i);
    await expect(consumeTavilyRefresh(env.DB, s)).rejects.toMatchObject({ status: 429, code: 'cap_session' });
  });
  it('30 live calls per day', async () => {
    await env.DB.prepare("DELETE FROM limits_counters WHERE key = 'tavily'").run();
    for (let i = 0; i < CAPS.tavilyPerDay; i++) await consumeTavilyCall(env.DB);
    await expect(consumeTavilyCall(env.DB)).rejects.toMatchObject({ status: 429, code: 'cap_day' });
    await env.DB.prepare("DELETE FROM limits_counters WHERE key = 'tavily'").run();
  });
});

describe('buyer intel (recorded Tavily fixtures)', () => {
  const calls: string[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('api.tavily.com/search')) return Response.json({ results: [{ title: 'About Teagasc', url: 'https://www.teagasc.ie/about/', content: 'Teagasc is the Agriculture and Food Development Authority, the national body providing integrated research, advisory and training services to the agriculture and food industry and rural communities.' }, { title: 'Digital services', url: 'https://www.teagasc.ie/digital/', content: 'Teagasc runs the Nutrient Management Planner and PastureBase Ireland web applications for advisors and farmers.' }] });
    if (u.includes('api.tavily.com/extract')) return Response.json({ results: [{ url: 'https://www.teagasc.ie/about/', raw_content: 'Teagasc, the Agriculture and Food Development Authority, provides research, advisory and education services.' }] });
    if (u.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      return Response.json({ id: 'x', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'Teagasc is the Irish agriculture and food development authority.', facts: [{ label: 'Remit', value: 'Research, advisory and training for agriculture and food', source_idx: 0 }, { label: 'Web applications', value: 'Nutrient Management Planner and PastureBase Ireland', source_idx: 1 }, { label: 'Bogus', value: 'dropped: source index out of range', source_idx: 9 }] }) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  const e = () => ({ ...env, TAVILY_API_KEY: 'tvly-test', NEBIUS_API_KEY: 'test' }) as Env;

  it('reading intel never calls Tavily (nothing runs on page load)', async () => {
    calls.length = 0;
    await buyerIntelImpl(e(), 'teagasc', { refresh: false, fetch: fetchFake });
    expect(calls).toEqual([]);
    await expect(buyerIntelImpl(e(), 'nobody', { refresh: false })).rejects.toMatchObject({ status: 404 });
  });

  it('a refresh searches, extracts, writes cited facts and counts the cap; the repeat is served from KV', async () => {
    const s = await session();
    await env.DB.prepare("DELETE FROM limits_counters WHERE key = 'tavily'").run();
    await env.CACHE.delete('tavily:s:force-miss');
    calls.length = 0;
    const intel = await buyerIntelImpl(e(), 'teagasc', { refresh: true, sessionId: s, fetch: fetchFake });
    expect(calls.filter((c) => c.includes('tavily')).length).toBe(2);
    expect(intel.sources).toHaveLength(2);
    expect(intel.facts.map((f) => f.label)).toEqual(['Remit', 'Web applications']);
    expect((await used(s)).tavily_used).toBe(1);
    const day = await env.DB.prepare("SELECT count FROM limits_counters WHERE key = 'tavily'").first<{ count: number }>();
    expect(day!.count).toBe(2);
    const stored = await env.DB.prepare('SELECT summary FROM buyer_intel WHERE buyer_key = ?').bind('teagasc').first<{ summary: string }>();
    expect(stored!.summary).toContain('agriculture');

    calls.length = 0;
    await buyerIntelImpl(e(), 'teagasc', { refresh: true, sessionId: s, fetch: fetchFake });
    expect(calls.filter((c) => c.includes('tavily'))).toEqual([]);
    expect((await used(s)).tavily_used).toBe(1);
  });

  it('refunds the session count when Tavily fails', async () => {
    const s = await session();
    await env.DB.prepare("INSERT OR IGNORE INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, lots_json) VALUES ('tnd_t_x', 'upload', 'x', 't', 'Fresh Buyer Ltd', 'fresh-buyer', 'IE', '[]', '[]')").run();
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(buyerIntelImpl(e(), 'fresh-buyer', { refresh: true, sessionId: s, fetch: failing })).rejects.toMatchObject({ status: 502 });
    expect((await used(s)).tavily_used).toBe(0);
  });
});
