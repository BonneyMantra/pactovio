import { endpoints } from '@pactovio/contracts';
import { one } from '../lib/db';
import { CAPS } from '../lib/types';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.getLimits, async ({ db, auth }) => {
    const s = auth.sessionId ? await one<{ runs_used: number; tavily_used: number }>(db, 'SELECT runs_used, tavily_used FROM judge_sessions WHERE id = ?', auth.sessionId) : null;
    return {
      session: { runs_used: s?.runs_used ?? 0, runs_cap: CAPS.runs, tavily_used: s?.tavily_used ?? 0, tavily_cap: CAPS.tavily, agent_turns_per_min_cap: CAPS.agentTurnsPerMin },
      inference: { rpm: 1000, tpm: 2_000_000, global_concurrency: 6, shared_across_products: 6 },
      note: 'Per-session judge caps. Inference limits are the shared Nebius Token Factory quota across six products.',
    };
  });
};
