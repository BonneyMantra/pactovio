import { HttpError, newId, type QuoteCreateInput } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { createQuote, lexicalScores } from '@pactovio/quote';
import type { z } from 'zod';

type Product = { id: string; sku: string; name: string; family: string | null; unit_price_minor: number; currency: string; unit: string | null; description: string | null };

/** Selling-price catalogue only. This query never joins product_costs, so internal costs cannot reach a draft or quote. */
async function sellingCatalogue(db: D1Database, workspace: string): Promise<Product[]> {
  const res = await db.prepare(`SELECT id, sku, name, family, unit_price_minor, currency, json_extract(specs_json, '$.unit') AS unit,
    json_extract(specs_json, '$.description') AS description FROM products WHERE workspace_id = ? ORDER BY sku LIMIT 5000`).bind(workspace).all<Product>();
  return res.results;
}

export async function quoteCandidates(db: D1Database, workspace: string, requestText: string) {
  const products = await sellingCatalogue(db, workspace);
  if (!products.length) throw new HttpError(409, 'Add your products first: quotes are priced only from your own catalogue.', 'catalogue_required');
  const items = products.map((p) => ({ p, text: [p.name, p.sku, p.family, p.description].filter(Boolean).join(' ') }));
  const ranked = lexicalScores(requestText, items, 10);
  return {
    candidates: ranked.map(({ item: { p }, score, matched }) => ({
      product_id: p.id, name: p.name, ...(p.sku ? { sku: p.sku } : {}), unit_price_minor: p.unit_price_minor, currency: p.currency,
      unit: p.unit ?? 'unit', score: Math.round(score * 100) / 100, matched_terms: matched.slice(0, 12),
    })),
    method: 'keyword' as const,
  };
}

/** Records the pasted request as a design intake + design request, then prices the chosen lines with the existing quote engine. */
export async function createOnboardingQuote(env: Env, workspace: string, input: z.infer<typeof QuoteCreateInput>) {
  const db = env.DB;
  const ph = input.lines.map(() => '?').join(',');
  const owned = await db.prepare(`SELECT COUNT(*) AS n FROM products WHERE workspace_id = ? AND id IN (${ph})`).bind(workspace, ...input.lines.map((l) => l.product_id)).first<{ n: number }>();
  if ((owned?.n ?? 0) !== input.lines.length) throw new HttpError(400, 'Choose products from your own catalogue.', 'validation');
  const intake = newId('intake'), design = newId('designRequest'), at = new Date().toISOString();
  const title = input.title || input.request_text.split(/\r?\n/)[0]!.slice(0, 120) || 'Customer request';
  // intakes.source has a CHECK constraint without 'onboarding'; the request was pasted by the customer, i.e. an upload.
  await db.batch([
    db.prepare(`INSERT INTO intakes (id, workspace_id, door, source, title, sender, received_at, status, classification_json, design_request_id)
      VALUES (?, ?, 'design', 'upload', ?, ?, ?, 'ready', ?, ?)`).bind(intake, workspace, title.slice(0, 200), input.customer?.trim() || null, at,
      JSON.stringify({ door: 'design', confidence: 1, origin: 'onboarding', reason: 'Request pasted by the customer during setup' }), design),
    db.prepare(`INSERT INTO design_requests (id, workspace_id, intake_id, customer, subject, spec_text, requirements_json, matches_json, status)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 'new')`).bind(design, workspace, intake, input.customer ?? '', title.slice(0, 200), input.request_text),
  ]);
  try {
    const quote = await createQuote(env, { workspaceId: workspace, designRequestId: design, lines: input.lines.map((l) => ({ productId: l.product_id, qty: l.qty })) });
    return { quote_id: quote.id, total_minor: quote.total_minor, currency: quote.currency, design_request_id: design,
      export: { docx: `/api/quotes/${quote.id}/export?format=docx`, xlsx: `/api/quotes/${quote.id}/export?format=xlsx` } };
  } catch (e) {
    // Do not leave a half-made request behind when pricing fails (e.g. mixed currencies).
    await db.batch([
      db.prepare('DELETE FROM design_requests WHERE id = ? AND workspace_id = ?').bind(design, workspace),
      db.prepare('DELETE FROM intakes WHERE id = ? AND workspace_id = ?').bind(intake, workspace),
    ]).catch(() => undefined);
    throw e;
  }
}
