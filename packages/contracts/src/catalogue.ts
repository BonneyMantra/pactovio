import { z } from 'zod';
export const PRODUCT_CURRENCIES = ['USD', 'EUR', 'GBP', 'MYR', 'INR', 'AUD', 'CAD', 'SGD', 'CHF', 'CNY',
  'HKD', 'NZD', 'AED', 'SAR', 'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'THB', 'ILS', 'BRL', 'MXN', 'PHP', 'TRY'] as const;
const money = z.number().int().nonnegative().max(1_000_000_000_000);
const currency = z.string().trim().toUpperCase().pipe(z.enum(PRODUCT_CURRENCIES));
const unit = z.string().trim().min(1).max(40);
export const ProductInput = z.object({
  sku: z.string().trim().min(1).max(64).transform(v => v.toUpperCase()).optional(),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().min(1).max(4096),
  family: z.string().trim().max(100).nullable().optional(),
  unit, unit_price_minor: money, currency,
  internal_unit_cost_minor: money, cost_currency: currency, cost_unit: unit,
  zero_price_confirmed: z.boolean().optional(), zero_cost_confirmed: z.boolean().optional(),
  /** Public product page; used to fetch the product image. */
  source_url: z.url().max(2048).refine((v) => /^https?:\/\//i.test(v), 'Use an http or https URL').optional(),
}).strict();
