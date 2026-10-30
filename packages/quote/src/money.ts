import type { QuoteLine } from '@pactovio/contracts';

/** Pure integer minor-unit pricing. No floats anywhere in the money path. */

export interface Buyer {
  /** ISO 3166-1 alpha-2, e.g. IE, DE, IN. */
  country: string;
  b2b: boolean;
  /** Buyer holds a validated VAT/tax id (needed for EU reverse charge). */
  vat_registered?: boolean;
}

export interface TaxRule {
  seller_country: string;
  domestic_bp: number;
  domestic_name: string;
  reverse_charge_eu_b2b: boolean;
  /** Country-specific tax for sales into that country, e.g. IN: GST 18%. */
  countries: Record<string, { bp: number; name: string }>;
  /** Rate for non-EU buyers without a country entry (export, zero-rated). */
  export_bp: number;
}

export interface PriceRules {
  currency: string;
  volume_tiers?: { min_qty: number; discount_bp: number }[];
  /** Explicit override, in basis points; skips country logic. */
  tax_bp?: number;
  tax?: TaxRule;
  buyer?: Buyer;
  [k: string]: unknown;
}

export interface QuoteTotals {
  lines: QuoteLine[];
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  tax_bp: number;
  tax_label: string;
}

export const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

export const DEFAULT_TAX: TaxRule = {
  seller_country: 'IE',
  domestic_bp: 2300,
  domestic_name: 'VAT (Ireland) 23%',
  reverse_charge_eu_b2b: true,
  countries: { IN: { bp: 1800, name: 'GST (India) 18%' } },
  export_bp: 0,
};

const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** round-half-up of (amount * bp / 10000) in integer arithmetic. */
export function bpOf(amount: number, bp: number): number {
  if (!isMinor(amount) || !Number.isSafeInteger(bp) || bp < 0 || bp > 10000 * 10) throw new RangeError('bpOf: invalid input');
  return Number((BigInt(amount) * BigInt(bp) + 5000n) / 10000n);
}

export function resolveTax(rules: PriceRules): { bp: number; label: string } {
  if (rules.tax_bp !== undefined) return { bp: rules.tax_bp, label: `Tax ${rules.tax_bp / 100}%` };
  const t = rules.tax ?? DEFAULT_TAX;
  const b = rules.buyer ?? { country: t.seller_country, b2b: true };
  const c = b.country.toUpperCase();
  const own = t.countries[c];
  if (c === t.seller_country) return { bp: t.domestic_bp, label: t.domestic_name };
  if (own) return { bp: own.bp, label: own.name };
  if (EU.has(c)) {
    if (b.b2b && b.vat_registered !== false && t.reverse_charge_eu_b2b) return { bp: 0, label: 'Reverse charge (EU B2B, Art. 196 VAT Directive): customer accounts for VAT' };
    return { bp: t.domestic_bp, label: t.domestic_name };
  }
  return { bp: t.export_bp, label: 'Zero-rated export (outside the EU)' };
}

export function tierDiscountBp(qty: number, tiers: PriceRules['volume_tiers']): number {
  let bp = 0;
  for (const t of tiers ?? []) if (qty >= t.min_qty && t.discount_bp > bp) bp = t.discount_bp;
  return bp;
}

export function priceQuote(
  input: Pick<QuoteLine, 'sku' | 'description' | 'qty' | 'unit_price_minor'>[],
  rules: PriceRules,
): QuoteTotals {
  let subtotal = 0;
  let discount = 0;
  const lines: QuoteLine[] = input.map((l) => {
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new RangeError(`qty must be a positive integer (${l.sku ?? l.description})`);
    if (!isMinor(l.unit_price_minor)) throw new RangeError(`unit_price_minor must be a non-negative integer (${l.sku ?? l.description})`);
    const gross = l.qty * l.unit_price_minor;
    if (!Number.isSafeInteger(gross)) throw new RangeError('line total overflows');
    const d = bpOf(gross, tierDiscountBp(l.qty, rules.volume_tiers));
    subtotal += gross;
    discount += d;
    return { sku: l.sku, description: l.description, qty: l.qty, unit_price_minor: l.unit_price_minor, discount_minor: d, line_total_minor: gross - d };
  });
  const net = subtotal - discount;
  const { bp, label } = resolveTax(rules);
  const tax = bpOf(net, bp);
  return { lines, subtotal_minor: subtotal, discount_minor: discount, tax_minor: tax, total_minor: net + tax, tax_bp: bp, tax_label: label };
}
