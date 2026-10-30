import {
  endpoints, HttpError, type Answer, type Document, type Requirement, type Run, type TenderMatch, type Verdict,
} from '@pactovio/contracts';
import { exec, one, rows } from '../lib/db';
import { MATCH_SELECT, requireTender, splitMatch } from '../lib/tenders';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listTenders, async ({ db, workspaceId, query }) => {
    const where = ['m.workspace_id = ?'];
    const b: unknown[] = [workspaceId];
    if (query.status) { where.push('m.status = ?'); b.push(query.status); }
    if (query.country) { where.push('t.country = ?'); b.push(query.country); }
    if (query.min_fit !== undefined) { where.push('m.fit_score >= ?'); b.push(query.min_fit); }
    if (query.q) { where.push('(t.title LIKE ? OR t.buyer LIKE ?)'); b.push(`%${query.q}%`, `%${query.q}%`); }
    const limit = query.limit ?? 50;
    const offset = Number(query.cursor ?? 0) || 0;
    const total = (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tender_matches m JOIN tenders t ON t.id = m.tender_id WHERE ${where.join(' AND ')}`, ...b))?.n ?? 0;
    const items = (await rows(db, `${MATCH_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.fit_score DESC, t.deadline LIMIT ? OFFSET ?`, ...b, limit, offset)).map(splitMatch);
    return { items, total, next_cursor: offset + limit < total ? String(offset + limit) : null };
  });

  r.on(endpoints.getTender, async ({ db, workspaceId, params }) => {
    const tender = await requireTender(db, params.id);
    const match = await one<TenderMatch>(db, 'SELECT * FROM tender_matches WHERE workspace_id = ? AND tender_id = ?', workspaceId, tender.id);
    const counts = await rows<{ status: string; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM requirements WHERE workspace_id = ? AND tender_id = ? GROUP BY status', workspaceId, tender.id);
    const c = (s: string) => counts.find((x) => x.status === s)?.n ?? 0;
    return {
      tender,
      match,
      documents: await rows<Document>(db, 'SELECT * FROM documents WHERE tender_id = ? ORDER BY filename', tender.id),
      latest_run: await one<Run>(db, "SELECT * FROM runs WHERE workspace_id = ? AND subject_type = 'tender' AND subject_id = ? ORDER BY started_at DESC LIMIT 1", workspaceId, tender.id),
      verdicts: await rows<Verdict>(db, 'SELECT * FROM verdicts WHERE workspace_id = ? AND tender_id = ? ORDER BY lot', workspaceId, tender.id),
      requirement_counts: { total: counts.reduce((a, x) => a + x.n, 0), MET: c('MET'), PARTIAL: c('PARTIAL'), GAP: c('GAP'), NEEDS_EVIDENCE: c('NEEDS_EVIDENCE') },
    };
  });

  r.stub(endpoints.startPackRun, 'engine.startPackRun');

  r.on(endpoints.getMatrix, async ({ db, workspaceId, params }) => {
    await requireTender(db, params.id);
    const requirements = await rows<Requirement>(db, 'SELECT * FROM requirements WHERE workspace_id = ? AND tender_id = ? ORDER BY lot, ref', workspaceId, params.id);
    const verdicts = await rows<Verdict>(db, 'SELECT * FROM verdicts WHERE workspace_id = ? AND tender_id = ? ORDER BY lot', workspaceId, params.id);
    const lots = [...new Set(requirements.map((q) => q.lot).filter((l): l is string => !!l))];
    return { tender_id: params.id, lots, requirements, verdicts };
  });

  r.on(endpoints.getVerdicts, async ({ db, workspaceId, params }) => {
    await requireTender(db, params.id);
    return { items: await rows<Verdict>(db, 'SELECT * FROM verdicts WHERE workspace_id = ? AND tender_id = ? ORDER BY lot', workspaceId, params.id) };
  });

  r.on(endpoints.listAnswers, async ({ db, workspaceId, params }) => {
    await requireTender(db, params.id);
    return { items: await rows<Answer>(db, 'SELECT * FROM answers WHERE workspace_id = ? AND tender_id = ? ORDER BY lot, question_ref', workspaceId, params.id) };
  });

  r.stub(endpoints.draftAnswer, 'engine.draftAnswers');

  r.on(endpoints.patchAnswer, async ({ db, workspaceId, params, body }) => {
    const a = await one<Answer>(db, 'SELECT * FROM answers WHERE id = ? AND tender_id = ? AND workspace_id = ?', params.answerId, params.id, workspaceId);
    if (!a) throw new HttpError(404, 'Answer not found', 'not_found');
    const draft = body.draft ?? a.draft;
    const status = body.status ?? a.status;
    if (body.draft !== undefined && body.draft !== a.draft && a.status === 'approved' && body.status !== 'draft') {
      throw new HttpError(409, 'Approved answers must be reopened (status: draft) before editing', 'conflict');
    }
    const approvedAt = status === 'approved' ? (a.approved_at ?? new Date().toISOString()) : null;
    await exec(db, 'UPDATE answers SET draft = ?, status = ?, approved_at = ? WHERE id = ?', draft, status, approvedAt, a.id);
    return { ...a, draft, status, approved_at: approvedAt };
  });

  r.stub(endpoints.fillForm, 'engine.fillForm');
  r.stub(endpoints.downloadForm, 'engine.fillForm');
};
