import { SESSION_CAPS, TAVILY_BUDGET, tavilyMonthUsed } from '@pactovio/billing';
import { HttpError } from '@pactovio/contracts';

/**
 * Judge-mode caps (BUILD-BRIEF section 4) and the Tavily budgets; the numbers come from @pactovio/billing so /limits and the
 * engine agree. Counters live in D1 so every Worker isolate agrees. `globalFreshRuns` protects the Token Factory quota
 * (2M TPM shared by six products): only one fresh pack run may be in flight at a time, replays are free.
 */
export const CAPS = { freshRuns: SESSION_CAPS.runs, tavilyRefreshes: SESSION_CAPS.tavily, tavilyPerDay: TAVILY_BUDGET.day, globalFreshRuns: 1 } as const;

const today = () => new Date().toISOString().slice(0, 10);

/** One fresh (non-replay) pack run for a judge session. Atomic: the UPDATE only succeeds below the cap. */
export async function consumeFreshRun(db: D1Database, sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  const r = await db.prepare('UPDATE judge_sessions SET runs_used = runs_used + 1 WHERE id = ? AND runs_used < ?').bind(sessionId, CAPS.freshRuns).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(429, `This session has used its ${CAPS.freshRuns} fresh pack runs. Replays are unlimited.`, 'cap_session');
}

export async function refundFreshRun(db: D1Database, sessionId: string | null | undefined): Promise<void> {
  if (sessionId) await db.prepare('UPDATE judge_sessions SET runs_used = MAX(0, runs_used - 1) WHERE id = ?').bind(sessionId).run();
}

/** One Tavily buyer refresh for a session (cap 3). Returns the new count. */
export async function consumeTavilyRefresh(db: D1Database, sessionId: string | null | undefined): Promise<number> {
  if (!sessionId) return 0;
  const r = await db.prepare('UPDATE judge_sessions SET tavily_used = tavily_used + 1 WHERE id = ? AND tavily_used < ?').bind(sessionId, CAPS.tavilyRefreshes).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(429, `This session has used its ${CAPS.tavilyRefreshes} buyer refreshes.`, 'cap_session');
  return (await db.prepare('SELECT tavily_used FROM judge_sessions WHERE id = ?').bind(sessionId).first<{ tavily_used: number }>())?.tavily_used ?? 0;
}

export async function refundTavilyRefresh(db: D1Database, sessionId: string | null | undefined): Promise<void> {
  if (sessionId) await db.prepare('UPDATE judge_sessions SET tavily_used = MAX(0, tavily_used - 1) WHERE id = ?').bind(sessionId).run();
}

/** One live Tavily HTTP call against the daily cap (30). Shares the `tavily` counter key with GET /limits. */
export async function consumeTavilyCall(db: D1Database): Promise<void> {
  const day = today();
  if ((await tavilyMonthUsed({ DB: db } as never)) >= TAVILY_BUDGET.month) throw new HttpError(429, `Monthly Tavily budget of ${TAVILY_BUDGET.month} live calls used.`, 'cap_month');
  await db.prepare('INSERT INTO limits_counters (key, day, count) VALUES (?, ?, 0) ON CONFLICT(key, day) DO NOTHING').bind('tavily', day).run();
  const r = await db.prepare('UPDATE limits_counters SET count = count + 1 WHERE key = ? AND day = ? AND count < ?').bind('tavily', day, CAPS.tavilyPerDay).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(429, `Daily Tavily budget of ${CAPS.tavilyPerDay} live calls reached.`, 'cap_day');
}
