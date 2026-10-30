import { endpoints, HttpError, type Workspace } from '@pactovio/contracts';
import { exec, one, rows } from '../lib/db';
import { CAPS } from '../lib/types';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  const getWs = async (db: D1Database, id: string): Promise<Workspace> => {
    const w = await one<Workspace>(db, 'SELECT * FROM workspaces WHERE id = ?', id);
    if (!w) throw new HttpError(404, 'Workspace not found', 'not_found');
    return w;
  };
  const sessionInfo = async (db: D1Database, sessionId: string | null, workspaceId: string) => {
    if (!sessionId) throw new HttpError(400, 'API-key calls have no judge session', 'no_session');
    const s = await one<{ runs_used: number; tavily_used: number }>(db, 'SELECT runs_used, tavily_used FROM judge_sessions WHERE id = ?', sessionId);
    return {
      session_id: sessionId,
      workspace_id: workspaceId,
      workspace: await getWs(db, workspaceId),
      caps: { runs: CAPS.runs, tavily: CAPS.tavily, agent_turns_per_min: CAPS.agentTurnsPerMin },
      runs_used: s?.runs_used ?? 0,
      tavily_used: s?.tavily_used ?? 0,
    };
  };

  r.on(endpoints.getSession, ({ db, auth }) => sessionInfo(db, auth.sessionId, auth.workspaceId));
  r.on(endpoints.listWorkspaces, async ({ db, auth }) => ({
    items: await rows<Workspace>(db, auth.via === 'apikey' ? 'SELECT * FROM workspaces WHERE id = ?' : 'SELECT * FROM workspaces WHERE sample = 1 ORDER BY name', ...(auth.via === 'apikey' ? [auth.workspaceId] : [])),
  }));
  r.on(endpoints.getWorkspace, async ({ db, params, auth }) => {
    const w = await getWs(db, params.id);
    if (auth.via === 'apikey' && w.id !== auth.workspaceId) throw new HttpError(404, 'Workspace not found', 'not_found');
    return w;
  });
  r.on(endpoints.switchWorkspace, async ({ db, body, auth }) => {
    if (!auth.sessionId) throw new HttpError(400, 'API-key calls have no judge session', 'no_session');
    const w = await getWs(db, body.workspace_id);
    if (!w.sample) throw new HttpError(403, 'Only sample workspaces can be switched to', 'forbidden');
    await exec(db, 'UPDATE judge_sessions SET workspace_id = ? WHERE id = ?', w.id, auth.sessionId);
    return sessionInfo(db, auth.sessionId, w.id);
  });
};
