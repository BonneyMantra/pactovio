import type { PlanId } from '@pactovio/contracts';

export const DODO_TEST_BASE = 'https://test.dodopayments.com';
export const PACTOVIO_BRAND_ID = 'brnd_0NqpuZNLjREo7rCh2FMoJ';
export const METER_EVENT = 'pactovio_credits';

export type CheckoutPlan = 'pro' | 'max' | 'credits';

/** Pricing in USD minor units. Plan ids stay `free|pro|max` (stable for the UI); display names are Scout, Team, Business. */
export const PLAN_CATALOG = [
  { id: 'free' as const, name: 'Scout', price_minor: 0, currency: 'USD', monthly_credits: 3, features: ['3 small pack reads a month', 'Sample workspaces', 'Calendar feed'] },
  { id: 'pro' as const, name: 'Team', price_minor: 14900, currency: 'USD', monthly_credits: 150, features: ['150 credits a month', 'Nightly scan', 'Connectors and agent chat', 'Webhooks'] },
  { id: 'max' as const, name: 'Business', price_minor: 44900, currency: 'USD', monthly_credits: 600, features: ['600 credits a month', 'Audit jobs', 'MCP and API keys', 'Priority runs'] },
];
export const CREDIT_PACK = { name: 'Credit pack', credits: 100, price_minor: 4000, currency: 'USD' };

/** Credits per action (live plan section 6). */
export const CREDIT_COSTS = {
  pack_read_small: 1,
  pack_read_medium: 2,
  pack_read_large: 4,
  design_match: 1,
  buyer_refresh: 1,
} as const;
export type CreditAction = keyof typeof CREDIT_COSTS;

export const planCredits = (plan: PlanId): number => PLAN_CATALOG.find((p) => p.id === plan)?.monthly_credits ?? 0;

/** Product ids written by scripts/setup-dodo.ts (test mode; ids are not secrets). */
export interface DodoProducts {
  mode: 'test_mode';
  brand_id: string;
  products: Partial<Record<CheckoutPlan, string>>;
  meter_id?: string | null;
  meter_event?: string;
}
