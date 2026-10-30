import type { DesignRequest } from '@pactovio/contracts';
import { pageOf } from './chunk';

export interface Cand { cid: string; text: string; title: string; docId: string | null }
export type Citation = NonNullable<NonNullable<DesignRequest['requirements'][number]['result']>['citation']>;
export interface Judged { key: string; status: 'MET' | 'PARTIAL' | 'GAP'; sku: string | null; note: string; chunk: string | null; quote: string | null; citation: Citation | null }

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[–—]/g, '-').trim();

/** The model's quote must appear verbatim (whitespace and dash insensitive) inside the candidate it names; otherwise there is no citation. */
export function resolveCitation(chunk: string | null, quote: string | null, cands: Cand[]): Citation | null {
  if (!chunk || !quote || quote.trim().length < 4) return null;
  const c = cands.find((x) => x.cid === chunk.trim());
  if (!c || !norm(c.text).includes(norm(quote))) return null;
  return { doc: c.title, doc_id: c.docId, page: pageOf(c.text), quote: quote.trim() };
}

type Req = DesignRequest['requirements'][number];
type Match = DesignRequest['matches'][number];

/** Fold per-requirement results into per-product matches: score, verdict, reasons, gaps, citations, proposed quantity. */
export function buildMatches(reqs: Req[], proposed: { sku: string; qty: number; why: string }[], products: { id: string; sku: string; name: string }[]): Match[] {
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const out = new Map<string, Match>();
  const get = (sku: string): Match | null => {
    const p = bySku.get(sku);
    if (!p) return null;
    if (!out.has(sku)) out.set(sku, { product_id: p.id, sku, score: 0, verdict: 'NO_FIT', reasons: [], gaps: [], citations: [] });
    return out.get(sku)!;
  };
  const tally = new Map<string, { met: number; partial: number; total: number }>();
  for (const r of reqs) {
    const res = r.result;
    if (!res?.sku) continue;
    const m = get(res.sku);
    if (!m) continue;
    const t = tally.get(res.sku) ?? { met: 0, partial: 0, total: 0 };
    t.total++;
    if (res.status === 'MET') { t.met++; m.reasons.push(`${r.text}: ${res.note}`); } else if (res.status === 'PARTIAL') { t.partial++; m.gaps.push(`${r.text}: ${res.note}`); } else m.gaps.push(`${r.text}: ${res.note}`);
    if (res.citation) m.citations!.push(res.citation);
    tally.set(res.sku, t);
  }
  for (const [sku, t] of tally) {
    const m = out.get(sku)!;
    m.score = Math.round(((t.met + t.partial * 0.5) / t.total) * 100) / 100;
    m.verdict = t.met === t.total ? 'FIT' : t.met + t.partial > 0 ? 'PARTIAL' : 'NO_FIT';
  }
  for (const p of proposed) {
    const m = get(p.sku);
    if (!m) continue;
    m.proposed_qty = p.qty;
    if (!tally.has(p.sku)) { m.verdict = 'FIT'; m.score = 1; m.reasons.push(p.why); }
  }
  return [...out.values()].sort((a, b) => (b.proposed_qty ? 1 : 0) - (a.proposed_qty ? 1 : 0) || b.score - a.score);
}
