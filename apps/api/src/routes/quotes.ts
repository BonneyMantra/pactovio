import { endpoints, HttpError, type Quote } from '@pactovio/contracts';
import { MIME, quoteDocx, quoteXlsx } from '@pactovio/quote';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listQuotes, async ({ db, workspaceId }) => ({
    items: await rows<Quote>(db, 'SELECT * FROM quotes WHERE workspace_id = ? ORDER BY id', workspaceId),
  }));
  r.on(endpoints.getQuote, async ({ db, workspaceId, params }) => {
    const q = await one<Quote>(db, 'SELECT * FROM quotes WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!q) throw new HttpError(404, 'Quote not found', 'not_found');
    return q;
  });
  r.on(endpoints.exportQuote, async ({ db, workspaceId, params, query }) => {
    const qt = await one<Quote>(db, 'SELECT * FROM quotes WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!qt) throw new HttpError(404, 'Quote not found', 'not_found');
    const ws = await one<{ name: string }>(db, 'SELECT name FROM workspaces WHERE id = ?', workspaceId);
    const dr = qt.design_request_id ? await one<{ customer: string; subject: string }>(db, 'SELECT customer, subject FROM design_requests WHERE id = ?', qt.design_request_id) : null;
    // The tax line is re-derived from the stored totals: the rate that reproduces tax_minor on the net amount.
    const net = qt.subtotal_minor - qt.discount_minor;
    const bp = net > 0 ? Math.round((qt.tax_minor * 10000) / net) : 0;
    const label = bp === 0 ? 'Tax 0% (EU reverse charge or zero-rated export)' : bp === 2300 ? 'VAT (Ireland) 23%' : bp === 1800 && qt.currency === 'INR' ? 'GST (India) 18%' : `Tax ${bp / 100}%`;
    const doc = { quote: qt, seller: ws?.name ?? 'Seller', customer: dr?.customer ?? 'Customer', subject: dr?.subject ?? null, tax_label: label, tax_bp: bp };
    const bytes = query.format === 'xlsx' ? quoteXlsx(doc) : quoteDocx(doc);
    return new Response(bytes, { headers: { 'content-type': MIME[query.format], 'content-disposition': `attachment; filename="quote-${qt.id}.${query.format}"`, 'cache-control': 'no-store' } });
  });
};
