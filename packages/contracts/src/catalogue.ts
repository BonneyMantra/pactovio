import { z } from 'zod';

export const PRODUCT_CURRENCIES = ['USD', 'EUR', 'GBP', 'MYR', 'INR', 'AUD', 'CAD', 'SGD', 'CHF', 'CNY',
  'HKD', 'NZD', 'AED', 'SAR', 'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'THB', 'ILS', 'BRL', 'MXN', 'PHP', 'TRY'] as const;

export const ProductInput = z.object({
  sku: z.string().trim().min(1).max(64).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(160),
  family: z.string().trim().max(100).nullable().optional(),
  unit: z.string().trim().min(1).max(40).default('each'),
  unit_price_minor: z.number().int().nonnegative().max(1_000_000_000_000),
  currency: z.string().trim().toUpperCase().pipe(z.enum(PRODUCT_CURRENCIES)),
}).strict();
