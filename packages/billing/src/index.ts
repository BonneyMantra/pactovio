import { NotImplemented, type PlanId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export type Plan = PlanId;
export interface PlanState {
  plan: Plan;
  status: string;
  currentPeriodEnd: string | null;
  creditsBalance: number;
}

/** Lane: billing. Plan and credit balance from subscriptions + credit_ledger. */
export async function getPlan(_env: Env, _workspaceId: string): Promise<PlanState> {
  throw new NotImplemented('billing.getPlan');
}

/** Lane: billing. Dodo Payments checkout session URL. */
export async function checkoutUrl(_env: Env, _workspaceId: string, _plan: Exclude<Plan, 'free'>): Promise<string> {
  throw new NotImplemented('billing.checkoutUrl');
}

/** Lane: billing. Spend credits (negative ledger row). `ref` makes it idempotent. Returns the new balance. */
export async function chargeCredits(_env: Env, _workspaceId: string, _credits: number, _reason: string, _ref: string): Promise<number> {
  throw new NotImplemented('billing.chargeCredits');
}
