/**
 * Idempotent Dodo TEST-mode setup for Pactovio. Run: `DODO_PAYMENTS_API_KEY=... npx tsx packages/billing/scripts/setup-dodo.ts`
 * (key from the vault via inject.sh). Only creates products under the Pactovio brand, found again by metadata
 * `{ app: 'pactovio', key }`. Writes ids to src/dodo-products.json. Never prints the key.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDIT_PACK, DODO_TEST_BASE, METER_EVENT, PACTOVIO_BRAND_ID, PLAN_CATALOG, type DodoProducts } from '../src/plans';

const key = process.env.DODO_PAYMENTS_API_KEY;
if (!key) throw new Error('DODO_PAYMENTS_API_KEY missing');
if (process.env.DODO_PAYMENTS_ENV && process.env.DODO_PAYMENTS_ENV !== 'test_mode') throw new Error('refusing: not test_mode');

async function dodo<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DODO_TEST_BASE}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Product { product_id: string; name: string; metadata?: Record<string, unknown> }
const listed = await dodo<{ items: Product[] }>('GET', '/products?page_size=100');
const find = (k: string) => listed.items.find((p) => p.metadata?.app === 'pactovio' && p.metadata?.key === k)?.product_id;

const recurring = (price: number) => ({
  type: 'recurring_price', price, currency: 'USD', discount_bps: 0, purchasing_power_parity: false, tax_inclusive: false,
  payment_frequency_count: 1, payment_frequency_interval: 'Month', subscription_period_count: 20, subscription_period_interval: 'Year',
});

const defs = [
  { k: 'pro' as const, name: 'Pactovio Team', description: 'Pre-sales engine for one supplier team: 150 credits a month.', price: recurring(PLAN_CATALOG[1]!.price_minor), credits: 150 },
  { k: 'max' as const, name: 'Pactovio Business', description: 'Pre-sales engine for larger bid teams: 600 credits a month.', price: recurring(PLAN_CATALOG[2]!.price_minor), credits: 600 },
  { k: 'credits' as const, name: 'Pactovio Credit pack (100)', description: '100 credits that never expire.', price: { type: 'one_time_price', price: CREDIT_PACK.price_minor, currency: 'USD', discount_bps: 0, purchasing_power_parity: false, tax_inclusive: false, pay_what_you_want: false }, credits: 100 },
];

const out: DodoProducts = { mode: 'test_mode', brand_id: PACTOVIO_BRAND_ID, products: {}, meter_id: null, meter_event: METER_EVENT };
for (const d of defs) {
  let id = find(d.k);
  if (!id) {
    const p = await dodo<Product>('POST', '/products', { name: d.name, description: d.description, tax_category: 'saas', brand_id: PACTOVIO_BRAND_ID, price: d.price, metadata: { app: 'pactovio', key: d.k, credits: d.credits } });
    id = p.product_id;
    process.stdout.write(`created ${d.k} ${id}\n`);
  } else process.stdout.write(`exists  ${d.k} ${id}\n`);
  out.products[d.k] = id;
}

// Usage meter: sum of `credits` on event `pactovio_credits`. Skipped quietly if the API refuses.
try {
  const meters = await dodo<{ items: { id: string; event_name: string }[] }>('GET', '/meters');
  let m = meters.items.find((x) => x.event_name === METER_EVENT);
  if (!m) m = await dodo('POST', '/meters', { name: 'Pactovio credits', event_name: METER_EVENT, measurement_unit: 'credit', aggregation: { type: 'sum', key: 'credits' } });
  out.meter_id = (m as { id: string }).id;
  process.stdout.write(`meter   ${out.meter_id}\n`);
} catch (e) {
  process.stdout.write(`meter unavailable: ${e instanceof Error ? e.message : e}\n`);
}
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/dodo-products.json'), JSON.stringify(out, null, 2) + '\n');
