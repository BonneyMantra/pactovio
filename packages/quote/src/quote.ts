import { fromRow, HttpError, newId, type Quote } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { priceQuote, type Buyer } from './money';
import { loadRules, unitPrice } from './rules';

export interface CreateQuoteInput {
  workspaceId: string;
  designRequestId?: string;
  tenderId?: string;
  productIds?: string[];
  qty?: number;
  buyer?: Partial<Buyer>;
}

type ProductRow = { id: string; sku: string; name: string; unit_price_minor: number; currency: string; specs: unknown };

/** Price and persist a quote. Lines come from explicit product ids, else from the matched proposals of the design request. */
export async function createQuote(env: Env, input: CreateQuoteInput): Promise<Quote> {
  const db = env.DB;
  const dr = input.designRequestId
    ? fromRow<{ id: string; workspace_id: string; status: string; requirements: { key: string; value?: string }[]; matches: { product_id: string; sku: string; verdict: string; proposed_qty?: number }[] }>(
        await db.prepare('SELECT * FROM design_requests WHERE id = ? AND workspace_id = ?').bind(input.designRequestId, input.workspaceId).first())
    : null;
  if (input.designRequestId && !dr?.id) throw new HttpError(404, 'Design request not found', 'not_found');

  const fromReq = (k: string) => dr?.requirements?.find((r) => r.key === k)?.value;
  const stated = Number.parseInt(fromReq('quantity') ?? '', 10);
  const buyer: Buyer = {
    country: (input.buyer?.country ?? fromReq('buyer_country') ?? 'IE').toUpperCase(),
    b2b: input.buyer?.b2b ?? true,
    vat_registered: input.buyer?.vat_registered,
  };

  let picks: { id: string; qty: number }[];
  if (input.productIds?.length) {
    const q = input.qty ?? (Number.isSafeInteger(stated) && stated > 0 ? stated : 1);
    picks = input.productIds.map((id) => ({ id, qty: q }));
  } else {
    if (!dr) throw new HttpError(400, 'product_ids or a design request is required', 'validation');
    if (dr.status === 'new') throw new HttpError(409, 'Run the match first: this design request has no proposed products yet', 'conflict');
    const proposed = (dr.matches ?? []).filter((m) => m.proposed_qty);
    const src = proposed.length ? proposed : (dr.matches ?? []).filter((m) => m.verdict === 'FIT').map((m) => ({ ...m, proposed_qty: input.qty ?? (stated > 0 ? stated : 1) }));
    picks = src.map((m) => ({ id: m.product_id, qty: input.qty ?? m.proposed_qty! }));
  }
  if (!picks.length) throw new HttpError(409, 'No products to quote', 'conflict');

  const ph = picks.map(() => '?').join(',');
  const prows = (await db.prepare(`SELECT id, sku, name, unit_price_minor, currency, specs_json FROM products WHERE workspace_id = ? AND id IN (${ph})`).bind(input.workspaceId, ...picks.map((p) => p.id)).all<Record<string, unknown>>()).results.map((r) => fromRow<ProductRow>(r));
  const byId = new Map(prows.map((p) => [p.id, p]));
  const missing = picks.filter((p) => !byId.has(p.id));
  if (missing.length) throw new HttpError(400, `Unknown product: ${missing[0]!.id}`, 'validation');

  const { rules, validity_days } = await loadRules(db, input.workspaceId, buyer);
  let totals;
  try {
    totals = priceQuote(picks.map((p) => { const pr = byId.get(p.id)!; return { sku: pr.sku, description: pr.name, qty: p.qty, unit_price_minor: unitPrice(pr, rules.currency) }; }), rules);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Cannot price this quote', 'validation');
  }
  const id = newId('quote');
  const valid_until = new Date(Date.now() + validity_days * 86_400_000).toISOString();
  const quote: Quote = { id, workspace_id: input.workspaceId, design_request_id: input.designRequestId ?? null, tender_id: input.tenderId ?? null, currency: rules.currency, lines: totals.lines, subtotal_minor: totals.subtotal_minor, discount_minor: totals.discount_minor, tax_minor: totals.tax_minor, total_minor: totals.total_minor, valid_until, status: 'ready' };
  await db.prepare('INSERT INTO quotes (id, workspace_id, design_request_id, tender_id, currency, lines_json, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, quote.workspace_id, quote.design_request_id, quote.tender_id, quote.currency, JSON.stringify(quote.lines), quote.subtotal_minor, quote.discount_minor, quote.tax_minor, quote.total_minor, valid_until, quote.status).run();
  if (dr) await db.prepare("UPDATE design_requests SET status = 'quoted' WHERE id = ?").bind(dr.id).run();
  await emit(env, input.workspaceId, 'quote.ready', { quote_id: id, design_request_id: quote.design_request_id, currency: quote.currency, total_minor: quote.total_minor, tax: totals.tax_label });
  return quote;
}
