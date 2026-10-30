import { endpoints, HttpError, type Document, type Intake } from '@pactovio/contracts';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listIntakes, async ({ db, workspaceId, query }) => {
    const where = ['workspace_id = ?'];
    const b: unknown[] = [workspaceId];
    if (query.door) { where.push('door = ?'); b.push(query.door); }
    if (query.status) { where.push('status = ?'); b.push(query.status); }
    return { items: await rows<Intake>(db, `SELECT * FROM intakes WHERE ${where.join(' AND ')} ORDER BY received_at DESC LIMIT ?`, ...b, query.limit ?? 50) };
  });
  r.on(endpoints.getIntake, async ({ db, workspaceId, params }) => {
    const intake = await one<Intake>(db, 'SELECT * FROM intakes WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!intake) throw new HttpError(404, 'Intake not found', 'not_found');
    return { intake, documents: await rows<Document>(db, 'SELECT * FROM documents WHERE intake_id = ?', intake.id) };
  });
  r.stub(endpoints.createIntake, 'IntakeWorkflow start');
};
