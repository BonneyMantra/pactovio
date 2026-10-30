export * from './plans';
export * from './ledger';
export * from './caps';
export * from './webhook';
export { createCheckout, createPortal, sendUsage, dodoProducts } from './dodo';
import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { createCheckout } from './dodo';
import type { PlanId as Plan } from '@pactovio/contracts';

/** Dodo checkout session URL for a paid plan. (The API route adds the return URL; this is the cross-lane signature.) */
export async function checkoutUrl(env: Env, workspaceId: string, plan: Exclude<Plan, 'free'>, returnUrl = 'https://pactovio.pages.dev/billing'): Promise<string> {
  if (plan !== 'pro' && plan !== 'max') throw new HttpError(400, 'Unknown plan', 'validation');
  const sub = await env.DB.prepare('SELECT dodo_customer_id AS c FROM subscriptions WHERE workspace_id = ?').bind(workspaceId).first<{ c: string | null }>();
  return createCheckout(env, { workspaceId, plan, returnUrl, customerId: sub?.c });
}
export type { Plan };
