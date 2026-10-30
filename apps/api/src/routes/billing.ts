import { endpoints, HttpError } from '@pactovio/contracts';
import { createCheckout, createPortal, getPlan, PLAN_CATALOG } from '@pactovio/billing';
import { one } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.getBilling, async ({ env, workspaceId }) => {
    const p = await getPlan(env, workspaceId);
    return { workspace_id: workspaceId, plan: p.plan, status: p.status, current_period_end: p.currentPeriodEnd, credits_balance: p.creditsBalance, plans: PLAN_CATALOG };
  });

  r.on(endpoints.billingCheckout, async ({ env, db, c, workspaceId, body }) => {
    const sub = await one<{ dodo_customer_id: string | null }>(db, 'SELECT dodo_customer_id FROM subscriptions WHERE workspace_id = ?', workspaceId);
    const origin = new URL(c.req.url).origin;
    const url = await createCheckout(env, { workspaceId, plan: body.plan, returnUrl: `${origin}/billing?checkout=return`, customerId: sub?.dodo_customer_id });
    return { url };
  });

  r.on(endpoints.billingPortal, async ({ env, db, workspaceId }) => {
    const sub = await one<{ dodo_customer_id: string | null }>(db, 'SELECT dodo_customer_id FROM subscriptions WHERE workspace_id = ?', workspaceId);
    if (!sub?.dodo_customer_id) throw new HttpError(409, 'No billing customer yet: complete a checkout first', 'no_customer');
    return { url: await createPortal(env, sub.dodo_customer_id) };
  });
};
