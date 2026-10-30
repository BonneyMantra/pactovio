import { toRow } from '@pactovio/contracts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, EMAILS, VOLUME_TIERS } from '@pactovio/quote/samples';
import { priceQuote } from '@pactovio/quote';

const q = (v: string | number | null): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

const DESIGN: { id: string; email: string; customer: string; intake: string | null }[] = [
  { id: 'dsg_sample_westbay', email: 'mail_k_port_fog', customer: 'Westbay Port Authority (sample customer)', intake: 'int_sample_design_westbay' },
  { id: 'dsg_k_nordwind', email: 'mail_k_windfarm_met', customer: 'Nordwind Energie GmbH (sample customer)', intake: null },
  { id: 'dsg_k_kilbrook', email: 'mail_k_county_rwis', customer: 'Kilbrook County Council (sample customer)', intake: null },
];

type Recorded = { result: { requirements: unknown[]; matches: { sku: string; proposed_qty?: number }[] } };
function recorded(): Recorded | null {
  try { return JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/samples/recorded/westbay-match.json'), 'utf8')) as Recorded; } catch { return null; }
}

/**
 * Three Kestrel design requests. Westbay carries the recorded Nemotron match (and a priced quote from it) so the demo opens populated;
 * the other two are unmatched, ready for a live match. Resets earlier sample state for these ids.
 */
export function designSql(): string[] {
  const rec = recorded();
  const lines = (rec?.result.matches ?? []).filter((m) => m.proposed_qty).flatMap((m) => {
    const p = CATALOG.find((c) => c.sku === m.sku);
    return p ? [{ sku: p.sku, description: p.name, qty: m.proposed_qty!, unit_price_minor: p.eur }] : [];
  });
  const quote = lines.length ? priceQuote(lines, { currency: 'EUR', volume_tiers: VOLUME_TIERS, buyer: { country: 'IE', b2b: true } }) : null;
  const quoteRow = quote ? toRow({ id: 'quo_sample_westbay', workspace_id: 'ws_kestrel_sensing', design_request_id: 'dsg_sample_westbay', tender_id: null, currency: 'EUR', lines: quote.lines, subtotal_minor: quote.subtotal_minor, discount_minor: quote.discount_minor, tax_minor: quote.tax_minor, total_minor: quote.total_minor, valid_until: '2026-12-15T00:00:00.000Z', status: 'ready' }) : null;
  return [
    `DELETE FROM quotes WHERE id = 'quo_sample_westbay';`,
    ...DESIGN.map((d) => {
      const e = EMAILS.find((x) => x.id === d.email)!;
      const seeded = d.id === 'dsg_sample_westbay' && rec && quoteRow;
      const row = toRow({ id: d.id, workspace_id: 'ws_kestrel_sensing', intake_id: d.intake, customer: d.customer, subject: e.subject, spec_text: e.body_text, requirements: seeded ? rec.result.requirements : [], matches: seeded ? rec.result.matches : [], status: seeded ? 'quoted' : 'new' });
      const cols = Object.keys(row);
      return `INSERT INTO design_requests (${cols.join(', ')}) VALUES (${cols.map((c) => q(row[c]!)).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')};`;
    }),
    ...(quoteRow ? [`INSERT INTO quotes (${Object.keys(quoteRow).join(', ')}) VALUES (${Object.values(quoteRow).map((v) => q(v!)).join(', ')});`] : []),
  ];
}
