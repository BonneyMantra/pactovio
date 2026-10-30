import { endpoints } from '@pactovio/contracts';
import { CONCURRENCY, INFERENCE_SHARED, SESSION_CAPS, TAVILY_BUDGET, tavilyDayUsed, tavilyMonthUsed } from '@pactovio/billing';
import { PRICES_ARE_ESTIMATES } from '@pactovio/models';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

interface Usage { model: string; calls: number; tokens_in: number; tokens_out: number; tokens_cached: number; cost_usd: number }
const SELECT = `SELECT s.model AS model, COUNT(*) AS calls, COALESCE(SUM(s.tokens_in),0) AS tokens_in, COALESCE(SUM(s.tokens_out),0) AS tokens_out,
  COALESCE(SUM(s.tokens_cached),0) AS tokens_cached, COALESCE(SUM(s.cost_usd),0) AS cost_usd FROM run_steps s JOIN runs r ON r.id = s.run_id
  WHERE s.model IS NOT NULL AND r.replay = 0`;
const sum = (u: Usage[]) => Number(u.reduce((a, x) => a + x.cost_usd, 0).toFixed(6));

/** Real numbers only: everything below is read from run_steps, counters or audits. Replayed showcase runs are excluded from usage. */
export const register: Register = (r) => {
  r.on(endpoints.getLimits, async ({ env, db, auth }) => {
    const day = new Date().toISOString().slice(0, 10);
    const s = auth.sessionId ? await one<{ runs_used: number; tavily_used: number }>(db, 'SELECT runs_used, tavily_used FROM judge_sessions WHERE id = ?', auth.sessionId) : null;
    const [today, all, audits, scan] = await Promise.all([
      rows<Usage>(db, `${SELECT} AND s.at >= ? GROUP BY s.model ORDER BY SUM(s.cost_usd) DESC`, `${day}T00:00:00.000Z`),
      rows<Usage>(db, `${SELECT} GROUP BY s.model ORDER BY SUM(s.cost_usd) DESC`),
      rows<{ id: string; job_id: string | null; status: string; subject_type: string; created_at: string; completed_at: string | null }>(db, 'SELECT id, job_id, status, subject_type, created_at, completed_at FROM audits WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 5', auth.workspaceId),
      one<{ id: string; status: string; started_at: string; finished_at: string | null }>(db, "SELECT id, status, started_at, finished_at FROM runs WHERE kind = 'scan' ORDER BY started_at DESC LIMIT 1"),
    ]);
    const tenders = scan ? (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM tenders'))?.n ?? 0 : 0;
    return {
      session: { runs_used: s?.runs_used ?? 0, runs_cap: SESSION_CAPS.runs, tavily_used: s?.tavily_used ?? 0, tavily_cap: SESSION_CAPS.tavily, agent_turns_per_min_cap: SESSION_CAPS.agentTurnsPerMin },
      inference: { rpm: INFERENCE_SHARED.rpm, tpm: INFERENCE_SHARED.tpm, global_concurrency: CONCURRENCY.live, shared_across_products: INFERENCE_SHARED.products, flex_concurrency: CONCURRENCY.flex },
      usage: { today, all_time: all, cost_today_usd: sum(today), cost_all_time_usd: sum(all), prices_are_estimates: PRICES_ARE_ESTIMATES },
      tavily: {
        session_used: s?.tavily_used ?? 0, session_cap: SESSION_CAPS.tavily,
        day_used: await tavilyDayUsed(env), day_cap: TAVILY_BUDGET.day, month_used: await tavilyMonthUsed(env), month_budget: TAVILY_BUDGET.month,
      },
      audits,
      last_scan: scan ? { run_id: scan.id, status: scan.status, started_at: scan.started_at, finished_at: scan.finished_at, tenders_total: tenders } : null,
      note: 'Usage is summed from live run steps (replays excluded); prices are estimates. Inference quota is the shared Nebius Token Factory limit across six products.',
    };
  });
};
