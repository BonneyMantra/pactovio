import { endpoints, type PlanId } from '@pactovio/contracts';
import { one } from '../lib/db';
import type { Register } from '../lib/router';

/** Sample plan catalogue (prices are placeholders until the billing lane wires Dodo products). */
const PLANS = [
  { id: 'free' as const, name: 'Free', price_minor: 0, currency: 'EUR', monthly_credits: 20, features: ['2 pack runs / session', 'Sample workspaces'] },
  { id: 'pro' as const, name: 'Pro', price_minor: 14900, currency: 'EUR', monthly_credits: 300, features: ['Nightly scan', 'Connectors', 'Agent chat'] },
  { id: 'max' as const, name: 'Max', price_minor: 49900, currency: 'EUR', monthly_credits: 1500, features: ['Everything in Pro', 'Audit jobs', 'MCP + API keys'] },
];

export const register: Register = (r) => {
  r.on(endpoints.getBilling, async ({ db, workspaceId }) => {
    const sub = await one<{ plan: PlanId; status: string; current_period_end: string | null }>(db, 'SELECT plan, status, current_period_end FROM subscriptions WHERE workspace_id = ?', workspaceId);
    const bal = await one<{ n: number }>(db, 'SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE workspace_id = ?', workspaceId);
    return {
      workspace_id: workspaceId,
      plan: sub?.plan ?? 'free',
      status: sub?.status ?? 'active',
      current_period_end: sub?.current_period_end ?? null,
      credits_balance: bal?.n ?? 0,
      plans: PLANS,
    };
  });
  r.stub(endpoints.billingCheckout, 'billing.checkoutUrl');
  r.stub(endpoints.billingPortal, 'billing portal');
};
