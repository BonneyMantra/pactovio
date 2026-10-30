import { fromRow } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { money } from './util';

export interface TenderLite { id: string; title: string; buyer: string | null; country: string | null; value_eur: number | null; deadline: string | null; url: string | null; raw: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface VerdictLite { lot: string | null; decision: 'BID' | 'NO_BID' | 'CONDITIONAL'; score: number; reasons: string[] }
export interface QuoteLite { id: string; currency: string; lines: { sku: string | null; description: string; qty: number; unit_price_minor: number; line_total_minor: number }[]; total_minor: number; valid_until: string | null; status: string; customer: string | null; subject: string | null; tender_id: string | null; design_request_id: string | null }

const one = async <T>(env: Env, sql: string, ...b: unknown[]): Promise<T | null> => {
  const r = await env.DB.prepare(sql).bind(...b).first<Record<string, unknown>>();
  return r ? fromRow<T>(r) : null;
};
const many = async <T>(env: Env, sql: string, ...b: unknown[]): Promise<T[]> => (await env.DB.prepare(sql).bind(...b).all<Record<string, unknown>>()).results.map((r) => fromRow<T>(r));

export async function loadTender(env: Env, id: string): Promise<TenderLite | null> {
  const t = await one<TenderLite & { raw: unknown }>(env, 'SELECT id, title, buyer, country, value_eur, deadline, url, raw_json FROM tenders WHERE id = ?', id);
  return t ? { ...t, raw: (t.raw && typeof t.raw === 'object' ? t.raw : {}) as Record<string, unknown> } : null;
}

export const loadVerdicts = (env: Env, workspaceId: string, tenderId: string) =>
  many<VerdictLite>(env, 'SELECT lot, decision, score, reasons_json FROM verdicts WHERE workspace_id = ? AND tender_id = ? ORDER BY lot', workspaceId, tenderId);

export function bestDecision(vs: VerdictLite[]): VerdictLite['decision'] | null {
  if (!vs.length) return null;
  return vs.some((v) => v.decision === 'BID') ? 'BID' : vs.some((v) => v.decision === 'CONDITIONAL') ? 'CONDITIONAL' : 'NO_BID';
}

export async function loadQuote(env: Env, workspaceId: string, id: string): Promise<QuoteLite | null> {
  const q = await one<QuoteLite & { tender_id: string | null; design_request_id: string | null }>(
    env,
    `SELECT q.id, q.currency, q.lines_json, q.total_minor, q.valid_until, q.status, q.tender_id, q.design_request_id,
            d.customer AS customer, d.subject AS subject
       FROM quotes q LEFT JOIN design_requests d ON d.id = q.design_request_id WHERE q.id = ? AND q.workspace_id = ?`, id, workspaceId,
  );
  if (!q) return null;
  if (!q.customer && q.tender_id) q.customer = (await loadTender(env, q.tender_id))?.buyer ?? null;
  return { ...q, lines: Array.isArray(q.lines) ? q.lines : [] };
}

export const loadGapRows = (env: Env, workspaceId: string, tenderId: string) =>
  many<{ id: string; lot: string | null; ref: string | null; text: string; status: string; note: string | null; page: number | null }>(
    env, "SELECT id, lot, ref, text, status, note, page FROM requirements WHERE workspace_id = ? AND tender_id = ? AND status IN ('GAP','NEEDS_EVIDENCE') ORDER BY CASE status WHEN 'GAP' THEN 0 ELSE 1 END, ref LIMIT 25", workspaceId, tenderId);

/** Plain-text quote, used for the DocuSign document and the Drive/Dropbox CSV. */
export function quoteText(q: QuoteLite): string {
  const rows = q.lines.map((l) => `${l.qty} x ${l.description}${l.sku ? ` [${l.sku}]` : ''}: ${money(l.line_total_minor, q.currency)}`);
  return [`Quote ${q.id}`, q.customer ? `For: ${q.customer}` : '', q.subject ? `Subject: ${q.subject}` : '', '', ...rows, '', `Total: ${money(q.total_minor, q.currency)}`, q.valid_until ? `Valid until: ${q.valid_until.slice(0, 10)}` : ''].filter((x, i, a) => x || (a[i - 1] && a[i + 1])).join('\n');
}

export function quoteCsv(q: QuoteLite): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = 'sku,description,qty,unit_price,line_total,currency';
  return [head, ...q.lines.map((l) => [esc(l.sku ?? ''), esc(l.description), l.qty, (l.unit_price_minor / 100).toFixed(2), (l.line_total_minor / 100).toFixed(2), q.currency].join(',')), `,Total,,,${(q.total_minor / 100).toFixed(2)},${q.currency}`].join('\n');
}
