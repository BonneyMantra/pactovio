import { endpoints, HttpError, type Workspace } from '@pactovio/contracts';
import { one } from '../lib/db';
import { sessionInfo } from '../lib/customer-session';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  const getWs = async (db: D1Database, id: string): Promise<Workspace> => {
    const w = await one<Workspace>(db, 'SELECT * FROM workspaces WHERE id = ? AND sample = 0', id);
    if (!w) throw new HttpError(404, 'Workspace not found', 'not_found');
    return w;
  };
  r.on(endpoints.getSession, async ({ db, auth }) => {
    if (!auth.userId) throw new HttpError(400, 'Use a customer session', 'no_session');
    return sessionInfo(db, auth);
  });
  r.on(endpoints.listWorkspaces, async ({ db, auth }) => ({ items: [await getWs(db, auth.workspaceId)] }));
  r.on(endpoints.getWorkspace, async ({ db, params, auth }) => {
    if (params.id !== auth.workspaceId) throw new HttpError(404, 'Workspace not found', 'not_found');
    return getWs(db, params.id);
  });
  r.on(endpoints.switchWorkspace, async ({ db, body, auth }) => {
    if (!auth.userId) throw new HttpError(400, 'Use a customer session', 'no_session');
    if (body.workspace_id !== auth.workspaceId) throw new HttpError(403, 'Workspace is not available to this session', 'forbidden');
    return sessionInfo(db, auth);
  });
};
