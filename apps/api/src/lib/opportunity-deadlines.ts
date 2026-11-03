import type { NoticeDetail } from '@pactovio/sources';
import { randomToken } from './db';

/** Key dates a saved tender states, written as workspace deadlines. Only dates the source gives; site visits, award and quote validity are not published by these sources. */
export interface TenderDate { kind: string; title: string; due_at: string; excerpt: string }
const KINDS: [keyof NoticeDetail['key_dates'], string, string][] = [
  ['tender_deadline', 'submission', 'Tender submission deadline'],
  ['participation_deadline', 'participation', 'Request to participate deadline'],
  ['enquiry_deadline', 'clarification', 'Clarification questions close'],
  ['opening_at', 'opening', 'Public opening of tenders'],
];
const SOURCE: Record<string, string> = { ted: 'TED', fts: 'Find a Tender', cf: 'Contracts Finder', wb: 'World Bank' };

export function tenderDates(detail: NoticeDetail, source: string, id: string, now = new Date()): TenderDate[] {
  const out: TenderDate[] = [];
  for (const [field, kind, title] of KINDS) {
    const v = detail.key_dates[field];
    if (!v || Number.isNaN(Date.parse(v))) continue;
    const day = v.slice(0, 10), timed = v.length > 10;
    if (Date.parse(`${day}T23:59:59Z`) < now.getTime()) continue;
    const when = timed ? `${day} ${v.slice(11, 16)} UTC` : day;
    out.push({ kind, title, due_at: day, excerpt: `${title}: ${when} (${SOURCE[source] ?? source} ${id}).` });
  }
  return out;
}

export async function saveTenderDates(db: D1Database, ws: string, tenderId: string, sourceTitle: string, dates: TenderDate[]): Promise<number> {
  if (!dates.length) return 0;
  const at = new Date().toISOString(), title = sourceTitle.slice(0, 200);
  // One open row per (tender, kind): a moved or retitled date replaces the old one instead of duplicating it.
  await db.batch(dates.flatMap((d) => [db.prepare(`DELETE FROM workspace_deadlines WHERE workspace_id = ? AND tender_id = ? AND kind = ? AND status = 'open'
    AND NOT (due_at = ? AND title = ? AND source_title = ?)`).bind(ws, tenderId, d.kind, d.due_at, d.title, title), db.prepare(`INSERT INTO workspace_deadlines (id, workspace_id, title, due_at, excerpt, source_title, status, created_at, tender_id, kind)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT(workspace_id, due_at, title, source_title) DO NOTHING`)
    .bind(`dln_${randomToken(12)}`, ws, d.title, d.due_at, d.excerpt, title, at, tenderId, d.kind)]));
  return dates.length;
}
