import { chargeCredits, CREDIT_COSTS, refundCredits } from '@pactovio/billing';
import { endpoints, newId } from '@pactovio/contracts';
import { buyerIntel } from '@pactovio/engine';
import { one } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  // Reads D1 only: Tavily is never called on page load.
  r.on(endpoints.getBuyer, async ({ env, params }) => buyerIntel(env, params.id, { refresh: false }));

  // The only route that calls Tavily live (KV-cached, 3 per judge session, daily and monthly budgets). Costs 1 credit
  // on real workspaces (sample workspaces are never charged); the credit is returned when the refresh fails.
  r.on(endpoints.refreshBuyer, async ({ env, db, auth, workspaceId, params }) => {
    const credits = CREDIT_COSTS.buyer_refresh;
    const ref = `buyer_refresh:${newId('run')}`;
    await chargeCredits(env, workspaceId, credits, 'buyer_refresh', ref);
    try {
      await buyerIntel(env, params.id, { refresh: true, sessionId: auth.sessionId ?? undefined });
    } catch (e) {
      await refundCredits(env, workspaceId, credits, 'buyer_refresh_refund', `refund:${ref}`).catch(() => undefined);
      throw e;
    }
    const s = auth.sessionId ? await one<{ tavily_used: number }>(db, 'SELECT tavily_used FROM judge_sessions WHERE id = ?', auth.sessionId) : null;
    return { buyer_key: params.id, refreshed: true, tavily_used: s?.tavily_used ?? 0 };
  });
};
