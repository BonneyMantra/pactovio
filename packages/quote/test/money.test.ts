import { describe, expect, it } from 'vitest';
import { bpOf, priceQuote, resolveTax, type PriceRules } from '../src/money';

const tiers = [{ min_qty: 5, discount_bp: 300 }, { min_qty: 10, discount_bp: 600 }, { min_qty: 25, discount_bp: 1000 }];
const base: PriceRules = { currency: 'EUR', volume_tiers: tiers };
const line = (qty: number, unit: number, sku = 'VS-210') => ({ sku, description: sku, qty, unit_price_minor: unit });

// mulberry32: deterministic PRNG so failures reproduce
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('priceQuote determinism', () => {
  it('known figures: 6 sensors, IE buyer, 3% tier, 23% VAT', () => {
    const t = priceQuote([line(6, 248000)], { ...base, buyer: { country: 'IE', b2b: true } });
    expect(t.subtotal_minor).toBe(1488000);
    expect(t.discount_minor).toBe(44640);
    expect(t.tax_minor).toBe(331973); // 1443360 * 23% = 331972.8, half-up
    expect(t.total_minor).toBe(1443360 + t.tax_minor);
  });
  it('rounds half up, never via floats', () => {
    expect(bpOf(5, 1000)).toBe(1); // 0.5 -> 1
    expect(bpOf(4, 1000)).toBe(0); // 0.4 -> 0
    expect(() => bpOf(1.5, 100)).toThrow();
  });
  it('rejects non-integer money and bad quantities', () => {
    expect(() => priceQuote([line(1, 19.99)], base)).toThrow(RangeError);
    expect(() => priceQuote([line(0, 100)], base)).toThrow(RangeError);
    expect(() => priceQuote([line(2.5, 100)], base)).toThrow(RangeError);
    expect(() => priceQuote([line(1, -5)], base)).toThrow(RangeError);
  });
  it('is pure and repeatable', () => {
    const a = priceQuote([line(7, 123457), line(1, 99)], base);
    const b = priceQuote([line(7, 123457), line(1, 99)], base);
    expect(a).toEqual(b);
  });
  it('property: totals always reconcile (1000 random quotes)', () => {
    const r = rng(20261030);
    const countries = ['IE', 'DE', 'FR', 'IN', 'US', 'NL', 'GB'];
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(r() * 6);
      const lines = Array.from({ length: n }, (_, k) => line(1 + Math.floor(r() * 60), Math.floor(r() * 9_000_000), `S${k}`));
      const buyer = { country: countries[Math.floor(r() * countries.length)]!, b2b: r() > 0.3, vat_registered: r() > 0.2 };
      const t = priceQuote(lines, { ...base, buyer });
      const net = t.lines.reduce((s, l) => s + l.line_total_minor, 0);
      expect(t.subtotal_minor - t.discount_minor).toBe(net);
      expect(t.total_minor).toBe(net + t.tax_minor);
      expect(t.lines.reduce((s, l) => s + l.discount_minor, 0)).toBe(t.discount_minor);
      expect(t.lines.reduce((s, l) => s + l.qty * l.unit_price_minor, 0)).toBe(t.subtotal_minor);
      for (const l of t.lines) {
        expect(Number.isInteger(l.line_total_minor)).toBe(true);
        expect(l.line_total_minor).toBeGreaterThanOrEqual(0);
        expect(l.discount_minor).toBeLessThanOrEqual(l.qty * l.unit_price_minor);
      }
      expect(Number.isInteger(t.tax_minor) && t.tax_minor >= 0).toBe(true);
    }
  });
  it('property: more quantity never raises the unit price after discount', () => {
    for (let q = 1; q < 40; q++) {
      const a = priceQuote([line(q, 100003)], base).lines[0]!;
      const b = priceQuote([line(q + 1, 100003)], base).lines[0]!;
      expect(b.line_total_minor / (q + 1)).toBeLessThanOrEqual(a.line_total_minor / q + 1);
    }
  });
});

describe('tax by buyer', () => {
  const tax = (country: string, b2b: boolean, vat_registered?: boolean) => resolveTax({ ...base, buyer: { country, b2b, vat_registered } });
  it('IE buyer pays 23% VAT, B2B or not', () => {
    expect(tax('IE', true).bp).toBe(2300);
    expect(tax('IE', false).bp).toBe(2300);
  });
  it('EU B2B with a VAT id: reverse charge, 0%', () => {
    const t = tax('DE', true, true);
    expect(t.bp).toBe(0);
    expect(t.label).toMatch(/Reverse charge/);
  });
  it('EU consumer or unregistered business pays Irish VAT', () => {
    expect(tax('FR', false).bp).toBe(2300);
    expect(tax('NL', true, false).bp).toBe(2300);
  });
  it('India: GST 18%', () => {
    const t = priceQuote([line(2, 5_000_000)], { ...base, currency: 'INR', buyer: { country: 'IN', b2b: true } });
    expect(t.tax_bp).toBe(1800);
    expect(t.tax_minor).toBe(bpOf(t.subtotal_minor - t.discount_minor, 1800));
  });
  it('non-EU export is zero-rated; explicit tax_bp overrides', () => {
    expect(tax('US', true).bp).toBe(0);
    expect(resolveTax({ ...base, tax_bp: 500, buyer: { country: 'DE', b2b: true } }).bp).toBe(500);
  });
});
