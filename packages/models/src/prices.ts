/**
 * Token Factory list prices, USD per 1M tokens (input / cached input / output), read from
 * https://tokenfactory.nebius.com/api/public/models_info on 30 Oct 2026. The daily spend cap counts against these.
 */
export const PRICES_ARE_ESTIMATES = false;

export interface Price { in: number; out: number; cachedIn?: number }

export const PRICES: Record<string, Price> = {
  'nvidia/Nemotron-3-Ultra-550b-a55b': { in: 1.0, out: 3.0, cachedIn: 0.12 },
  'nvidia/Nemotron-3.5-Super-VL': { in: 0.3, out: 0.9, cachedIn: 0.06 },
  'nvidia/Nemotron-3_5-Lightning': { in: 0.06, out: 0.24, cachedIn: 0.03 },
  'Qwen/Qwen3-Embedding-8B': { in: 0.01, out: 0 },
};
/** Flex-tier discount is not published as a number, so cost is counted at full list price. */
export const FLEX_MULTIPLIER = 1;

export function costUsd(model: string, tokensIn: number, tokensOut: number, tokensCached = 0, flex = false): number {
  const p = PRICES[model] ?? { in: 1.0, out: 3.0 }; // unknown model: count at the most expensive list price
  const fresh = Math.max(0, tokensIn - tokensCached);
  const usd = (fresh * p.in + tokensCached * (p.cachedIn ?? p.in) + tokensOut * p.out) / 1_000_000;
  return Number((usd * (flex ? FLEX_MULTIPLIER : 1)).toFixed(6));
}
