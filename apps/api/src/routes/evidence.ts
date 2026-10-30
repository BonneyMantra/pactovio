import { endpoints, HttpError, type Evidence } from '@pactovio/contracts';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listEvidence, async ({ db, workspaceId, query }) => ({
    items: await rows<Evidence>(db, 'SELECT * FROM evidence WHERE workspace_id = ? ORDER BY kind, title LIMIT ?', workspaceId, query.limit ?? 100),
  }));
  r.on(endpoints.getEvidence, async ({ db, workspaceId, params }) => {
    const e = await one<Evidence>(db, 'SELECT * FROM evidence WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!e) throw new HttpError(404, 'Evidence not found', 'not_found');
    return e;
  });
  r.stub(endpoints.uploadEvidence, 'pack evidence ingest');
};
