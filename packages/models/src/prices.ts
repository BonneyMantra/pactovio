/**
 * ESTIMATE ONLY. USD per 1M tokens. Not verified against the Nebius Token Factory price list;
 * the models package will be updated when the list is read. Costs in run_steps are therefore estimates.
 */
export const PRICES_ARE_ESTIMATES = true;

export interface Price { in: number; out: number; cachedIn?: number }

export const PRICES: Record<string, Price> = {
  'nvidia/Nemotron-3-Ultra-550b-a55b': { in: 0.6, out: 1.8, cachedIn: 0.15 },
  'nvidia/Nemotron-3.5-Super-VL': { in: 0.3, out: 0.9, cachedIn: 0.08 },
  'nvidia/Nemotron-3_5-Lightning': { in: 0.06, out: 0.18, cachedIn: 0.02 },
  'Qwen/Qwen3-Embedding-8B': { in: 0.01, out: 0 },
};
/** Flex tier is discounted; estimate. */
export const FLEX_MULTIPLIER = 0.5;

export function costUsd(model: string, tokensIn: number, tokensOut: number, tokensCached = 0, flex = false): number {
  const p = PRICES[model] ?? { in: 0.5, out: 1.5 };
  const fresh = Math.max(0, tokensIn - tokensCached);
  const usd = (fresh * p.in + tokensCached * (p.cachedIn ?? p.in) + tokensOut * p.out) / 1_000_000;
  return Number((usd * (flex ? FLEX_MULTIPLIER : 1)).toFixed(6));
}
