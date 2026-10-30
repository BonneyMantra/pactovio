import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import products from './dodo-products.json';
import { DODO_TEST_BASE, METER_EVENT, type CheckoutPlan, type DodoProducts } from './plans';

export const dodoProducts = products as DodoProducts;

/** TEST mode only. DODO_API_BASE may override for tests but must stay a test.* host or localhost. */
export function dodoBase(env: Pick<Env, 'DODO_API_BASE'>): string {
  const b = env.DODO_API_BASE ?? DODO_TEST_BASE;
  if (!/^https:\/\/test\.dodopayments\.com|^http:\/\/localhost/.test(b)) throw new HttpError(500, 'Dodo base must be test mode', 'internal');
  return b;
}

export async function dodoFetch<T>(env: Env, method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  if (!env.DODO_PAYMENTS_API_KEY) throw new HttpError(500, 'Billing is not configured', 'not_configured');
  const res = await fetch(`${dodoBase(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.DODO_PAYMENTS_API_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(502, `Dodo returned ${res.status}`, 'upstream');
  return (await res.json()) as T;
}

export async function createCheckout(env: Env, args: { workspaceId: string; plan: CheckoutPlan; returnUrl: string; customerId?: string | null }): Promise<string> {
  const productId = dodoProducts.products[args.plan];
  if (!productId) throw new HttpError(409, 'Plan has no Dodo product yet', 'conflict');
  const r = await dodoFetch<{ checkout_url: string | null }>(env, 'POST', '/checkouts', {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: args.customerId ? { customer_id: args.customerId } : undefined,
    return_url: args.returnUrl,
    metadata: { workspace_id: args.workspaceId, plan: args.plan },
  });
  if (!r.checkout_url) throw new HttpError(502, 'Dodo returned no checkout URL', 'upstream');
  return r.checkout_url;
}

export async function createPortal(env: Env, customerId: string): Promise<string> {
  const r = await dodoFetch<{ link?: string }>(env, 'POST', `/customers/${encodeURIComponent(customerId)}/customer-portal/session`, {});
  if (!r.link) throw new HttpError(502, 'Dodo returned no portal link', 'upstream');
  return r.link;
}

/** Best effort usage event for the `pactovio_credits` meter. Never throws; the ledger is the source of truth. */
export async function sendUsage(env: Env, customerId: string | null, eventId: string, credits: number, reason: string): Promise<boolean> {
  if (!customerId || !env.DODO_PAYMENTS_API_KEY || !dodoProducts.meter_id) return false;
  try {
    await dodoFetch(env, 'POST', '/events/ingest', { events: [{ event_id: eventId, customer_id: customerId, event_name: METER_EVENT, metadata: { credits, reason } }] }, 4000);
    return true;
  } catch {
    return false;
  }
}
