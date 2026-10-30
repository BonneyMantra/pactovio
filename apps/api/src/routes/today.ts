import { endpoints, type Intake, type Run, type Tender } from '@pactovio/contracts';
import { one, rows } from '../lib/db';
import { splitMatch, MATCH_SELECT } from '../lib/tenders';
import type { Register } from '../lib/router';

const DAY = 86_400_000;

export const register: Register = (r) => {
  r.on(endpoints.getToday, async ({ db, workspaceId }) => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const matches = (await rows(db, `${MATCH_SELECT} WHERE m.workspace_id = ? ORDER BY m.fit_score DESC LIMIT 10`, workspaceId)).map(splitMatch);
    const closing = await rows<Tender>(
      db,
      `SELECT t.* FROM tenders t JOIN tender_matches m ON m.tender_id = t.id
       WHERE m.workspace_id = ? AND m.status != 'dismissed' AND t.deadline IS NOT NULL AND t.deadline > ? ORDER BY t.deadline LIMIT 5`,
      workspaceId, iso,
    );
    const intakes = await rows<Intake>(db, `SELECT * FROM intakes WHERE workspace_id = ? ORDER BY received_at DESC LIMIT 10`, workspaceId);
    const approvals = await rows<{ answer_id: string; tender_id: string; question_ref: string; tender_title: string }>(
      db,
      `SELECT a.id AS answer_id, a.tender_id, a.question_ref, t.title AS tender_title FROM answers a JOIN tenders t ON t.id = a.tender_id
       WHERE a.workspace_id = ? AND a.status = 'draft' ORDER BY a.question_ref LIMIT 10`,
      workspaceId,
    );
    const horizon = new Date(now + 120 * DAY).toISOString().slice(0, 10);
    const expiring = await rows<{ evidence_id: string; title: string; valid_to: string }>(
      db,
      `SELECT id AS evidence_id, title, valid_to FROM evidence WHERE workspace_id = ? AND valid_to IS NOT NULL AND valid_to <= ? ORDER BY valid_to LIMIT 10`,
      workspaceId, horizon,
    );
    const recent = await rows<Run>(db, 'SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 5', workspaceId);
    const count = async (sql: string, ...b: unknown[]) => (await one<{ n: number }>(db, sql, ...b))?.n ?? 0;
    const days = (d: string) => Math.round(((new Date(d).getTime() - now) / DAY) * 10) / 10;

    return {
      workspace_id: workspaceId,
      generated_at: iso,
      counts: {
        new_matches: await count("SELECT COUNT(*) AS n FROM tender_matches WHERE workspace_id = ? AND status = 'new'", workspaceId),
        open_intakes: await count("SELECT COUNT(*) AS n FROM intakes WHERE workspace_id = ? AND status IN ('new','classified','processing')", workspaceId),
        approvals_pending: await count("SELECT COUNT(*) AS n FROM answers WHERE workspace_id = ? AND status = 'draft'", workspaceId),
        expiring_certificates: expiring.length,
        runs_today: await count('SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND started_at >= ?', workspaceId, iso.slice(0, 10)),
      },
      top_matches: matches,
      closing_soon: closing.map((t) => ({ tender_id: t.id, title: t.title, buyer: t.buyer, deadline: t.deadline!, days_left: days(t.deadline!) })),
      intakes,
      approvals,
      expiring: expiring.map((e) => ({ ...e, days_left: days(e.valid_to) })),
      recent_runs: recent,
    };
  });
};
