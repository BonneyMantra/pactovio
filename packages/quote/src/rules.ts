import { fromRow } from '@pactovio/contracts';
import { DEFAULT_TAX, type Buyer, type PriceRules, type TaxRule } from './money';

export interface LoadedRules { rules: PriceRules; validity_days: number; currency_by_country: Record<string, string>; default_currency: string }

/** Merge workspace rules. New customers use their own catalogue currency and confirm unconfigured taxes. */
export async function loadRules(db: D1Database, workspaceId: string, buyer: Buyer, currencyHint?: string): Promise<LoadedRules> {
  const res = await db.prepare('SELECT kind, rule_json FROM price_rules WHERE workspace_id = ?').bind(workspaceId).all<Record<string, unknown>>();
  const byKind: Record<string, Record<string, unknown>> = {};
  for (const r of res.results) byKind[String(r.kind)] = fromRow<{ rule: Record<string, unknown> }>(r).rule ?? {};
  const cur = byKind.currency as { default?: string; by_country?: Record<string, string> } | undefined;
  const by = cur?.by_country ?? { IN: 'INR' };
  const currency = cur ? by[buyer.country.toUpperCase()] ?? cur.default ?? 'EUR' : currencyHint ?? by[buyer.country.toUpperCase()] ?? 'EUR';
  const tax = { ...DEFAULT_TAX, ...(byKind.tax as Partial<TaxRule> | undefined) };
  const workspace = await db.prepare('SELECT sample FROM workspaces WHERE id = ?').bind(workspaceId).first<{ sample: number }>();
  const taxUnconfigured = workspace?.sample === 0 && !byKind.tax;
  return {
    rules: { currency, volume_tiers: (byKind.volume_discount as { tiers?: PriceRules['volume_tiers'] } | undefined)?.tiers ?? [], tax, buyer, ...(taxUnconfigured ? { tax_bp: 0, tax_unconfigured: true } : {}) },
    validity_days: (byKind.validity as { days?: number } | undefined)?.days ?? 30,
    currency_by_country: by,
    default_currency: cur?.default ?? currencyHint ?? 'EUR',
  };
}

/** Unit price in the quote currency from product specs.prices (EUR/INR list); falls back to the EUR price only when currency is EUR. */
export function unitPrice(product: { unit_price_minor: number; currency: string; specs: unknown }, currency: string): number {
  const prices = (product.specs as { prices?: Record<string, number> } | null)?.prices;
  if (prices && typeof prices[currency] === 'number') return prices[currency]!;
  if (product.currency === currency) return product.unit_price_minor;
  throw new Error(`No ${currency} price for this product`);
}
