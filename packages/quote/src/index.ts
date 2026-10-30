import { NotImplemented, type DesignRequest, type Quote, type QuoteLine } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export interface PriceRules {
  currency: string;
  /** e.g. volume tiers [{ min_qty, discount_bp }] in basis points. */
  volume_tiers?: { min_qty: number; discount_bp: number }[];
  tax_bp?: number;
  [k: string]: unknown;
}
export interface QuoteTotals {
  lines: QuoteLine[];
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
}

/** Lane: quote. Extract requirements, match against products, persist matches_json. */
export async function matchDesignRequest(_env: Env, _designRequestId: string): Promise<DesignRequest> {
  throw new NotImplemented('quote.matchDesignRequest');
}

/** Lane: quote. PURE integer-minor-unit pricing. No I/O. */
export function priceQuote(_lines: Pick<QuoteLine, 'sku' | 'description' | 'qty' | 'unit_price_minor'>[], _rules: PriceRules): QuoteTotals {
  throw new NotImplemented('quote.priceQuote');
}

/** Lane: quote. Price and persist a quote for a design request or tender. */
export async function createQuote(
  _env: Env,
  _input: { workspaceId: string; designRequestId?: string; tenderId?: string; productIds?: string[]; qty?: number },
): Promise<Quote> {
  throw new NotImplemented('quote.createQuote');
}
