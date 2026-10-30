import { endpoints } from '@pactovio/contracts';
import { buyerIntel } from '@pactovio/engine';
import { one } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  // Reads D1 only: Tavily is never called on page load.
  r.on(endpoints.getBuyer, async ({ env, params }) => buyerIntel(env, params.id, { refresh: false }));

  // The only route that calls Tavily live (KV-cached, 3 per judge session, 30 live calls per day).
  r.on(endpoints.refreshBuyer, async ({ env, db, auth, params }) => {
    await buyerIntel(env, params.id, { refresh: true, sessionId: auth.sessionId ?? undefined });
    const s = auth.sessionId ? await one<{ tavily_used: number }>(db, 'SELECT tavily_used FROM judge_sessions WHERE id = ?', auth.sessionId) : null;
    return { buyer_key: params.id, refreshed: true, tavily_used: s?.tavily_used ?? 0 };
  });
};

