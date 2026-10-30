import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export const SESSION_CAPS = { runs: 2, tavily: 3, agentTurnsPerMin: 10 } as const;
export const TAVILY_BUDGET = { day: 25, month: 150 } as const;
export const CONCURRENCY = { live: 6, flex: 4 } as const;
export const INFERENCE_SHARED = { rpm: 1000, tpm: 2_000_000, products: 6 } as const;

const today = () => new Date().toISOString().slice(0, 10);

async function bump(env: Env, key: string, day: string): Promise<number> {
  await env.DB.prepare('INSERT INTO limits_counters (key, day, count) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET count = count + 1').bind(key, day).run();
  return (await env.DB.prepare('SELECT count FROM limits_counters WHERE key = ? AND day = ?').bind(key, day).first<{ count: number }>())?.count ?? 0;
}

export async function tavilyMonthUsed(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM limits_counters WHERE key = 'tavily' AND day >= ?").bind(`${today().slice(0, 7)}-01`).first<{ n: number }>();
  return r?.n ?? 0;
}
export async function tavilyDayUsed(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT count FROM limits_counters WHERE key = 'tavily' AND day = ?").bind(today()).first<{ count: number }>())?.count ?? 0;
}

/**
 * Reserve one live Tavily call. Call BEFORE the request. Enforces the judge-session cap (3), the daily cap and the
 * 150/month budget; throws 429 (code `cap_session` | `cap_day` | `cap_month`) without consuming on refusal.
 * `sessionId` null (API key / nightly scan) skips only the session cap.
 */
export async function reserveTavily(env: Env, sessionId: string | null): Promise<void> {
  if (sessionId) {
    const r = await env.DB.prepare('UPDATE judge_sessions SET tavily_used = tavily_used + 1 WHERE id = ? AND tavily_used < ?').bind(sessionId, SESSION_CAPS.tavily).run();
    if ((r.meta.changes ?? 0) === 0) throw new HttpError(429, `Judge session limit: ${SESSION_CAPS.tavily} buyer refreshes`, 'cap_session');
  }
  const refund = () => sessionId ? env.DB.prepare('UPDATE judge_sessions SET tavily_used = MAX(0, tavily_used - 1) WHERE id = ?').bind(sessionId).run() : Promise.resolve();
  if ((await tavilyMonthUsed(env)) >= TAVILY_BUDGET.month) { await refund(); throw new HttpError(429, 'Monthly Tavily budget used', 'cap_month'); }
  if ((await tavilyDayUsed(env)) >= TAVILY_BUDGET.day) { await refund(); throw new HttpError(429, 'Daily Tavily cap reached', 'cap_day'); }
  await bump(env, 'tavily', today());
}

/** Reserve one fresh (non-replay) pack run for a judge session; throws 429 `cap_session` at the cap. */
export async function reserveRun(env: Env, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const r = await env.DB.prepare('UPDATE judge_sessions SET runs_used = runs_used + 1 WHERE id = ? AND runs_used < ?').bind(sessionId, SESSION_CAPS.runs).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(429, `Judge session limit: ${SESSION_CAPS.runs} fresh pack runs`, 'cap_session');
}

/** Per-session agent turn limiter (10 a minute). Counter rows are keyed by session and UTC minute. */
export async function reserveAgentTurn(env: Env, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const n = await bump(env, `agent:${sessionId}`, new Date().toISOString().slice(0, 16));
  if (n > SESSION_CAPS.agentTurnsPerMin) throw new HttpError(429, 'Too many agent messages, wait a minute', 'cap_rate');
}
