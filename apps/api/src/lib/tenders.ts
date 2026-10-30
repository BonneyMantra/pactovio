import { fromRow, HttpError, type Tender, type TenderMatch } from '@pactovio/contracts';
import { one } from './db';

/** Tender columns + match columns (aliased m_*). Use with `splitMatch`. */
export const MATCH_SELECT = `SELECT t.*, m.workspace_id AS m_workspace_id, m.tender_id AS m_tender_id, m.fit_score AS m_fit_score,
  m.fit_reason AS m_fit_reason, m.status AS m_status, m.created_at AS m_created_at
  FROM tender_matches m JOIN tenders t ON t.id = m.tender_id`;

export function splitMatch(row: Record<string, unknown>): { tender: Tender; match: TenderMatch } {
  const t: Record<string, unknown> = {};
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('m_')) m[k.slice(2)] = v;
    else t[k] = v;
  }
  return { tender: fromRow<Tender>(t), match: fromRow<TenderMatch>(m) };
}

export async function requireTender(db: D1Database, id: string): Promise<Tender> {
  const t = await one<Tender>(db, 'SELECT * FROM tenders WHERE id = ?', id);
  if (!t) throw new HttpError(404, 'Tender not found', 'not_found');
  return t;
}
