import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HttpError, newId, type Workspace } from '@pactovio/contracts';
import { one, nowIso, randomToken, sha256Hex } from './db';
import type { AppEnv, Auth } from './types';
import { CAPS } from './types';
import { sameOrigin } from './customer-security';

export const CUSTOMER_COOKIE = 'pv_customer';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export function customerCookie(c: Context<AppEnv>, token: string, maxAge = SESSION_SECONDS): void {
  const secure = c.env.ENVIRONMENT !== 'development' || new URL(c.req.url).protocol === 'https:';
  setCookie(c, CUSTOMER_COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge });
}

export async function customerAuth(c: Context<AppEnv>): Promise<Auth> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.header('upgrade')?.toLowerCase() === 'websocket') sameOrigin(c);
  const token = getCookie(c, CUSTOMER_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Sign in to continue', 'unauthorized');
  const row = await c.env.DB.prepare(`SELECT s.id, s.workspace_id, s.user_id FROM customer_sessions s
    JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    JOIN workspaces w ON w.id = s.workspace_id AND w.sample = 0
    WHERE s.token_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL`).bind(await sha256Hex(token), Date.now())
    .first<{ id: string; workspace_id: string; user_id: string }>();
  if (!row) throw new HttpError(401, 'Sign in to continue', 'unauthorized');
  return { workspaceId: row.workspace_id, sessionId: row.id, userId: row.user_id, via: 'session' };
}

/** D1 batch makes first login's workspace, identity, membership and session one transaction. */
export async function createCustomerSession(c: Context<AppEnv>, email: string): Promise<Auth> {
  const db = c.env.DB;
  const ws = newId('workspace'), user = `usr_${randomToken(16)}`, id = newId('session');
  const at = nowIso(), token = randomToken(32), now = Date.now();
  const profile = JSON.stringify({ legal_name: '', hq: { city: '', country: '' }, capabilities: [], services: [], certifications: [], references: [], sites: [], turnover: [], regions: [], cpv_focus: [], keywords: [] });
  await db.batch([
    db.prepare(`INSERT INTO workspaces (id, name, segment, profile_json, sample, created_at)
      SELECT ?, 'Your company', 'industrial', ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM customer_users WHERE email = ?)`).bind(ws, profile, at, email),
    db.prepare('INSERT OR IGNORE INTO customer_users (id, email, workspace_id, verified_at) VALUES (?, ?, ?, ?)').bind(user, email, ws, at),
    db.prepare(`INSERT OR IGNORE INTO workspace_members (user_id, workspace_id) SELECT id, workspace_id FROM customer_users WHERE id = ?`).bind(user),
    db.prepare(`INSERT OR IGNORE INTO company_onboarding (workspace_id, updated_at) SELECT workspace_id, ? FROM customer_users WHERE email = ?`).bind(at, email),
    db.prepare(`INSERT INTO customer_sessions (id, token_hash, user_id, workspace_id, created_at, expires_at)
      SELECT ?, ?, u.id, u.workspace_id, ?, ? FROM customer_users u JOIN workspaces w ON w.id = u.workspace_id AND w.sample = 0
      JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = u.workspace_id WHERE u.email = ?`)
      .bind(id, await sha256Hex(token), now, now + SESSION_SECONDS * 1000, email),
    // Existing engine/billing caps use judge_sessions as counters, never as customer authentication.
    db.prepare('INSERT INTO judge_sessions (id, workspace_id, created_at) SELECT id, workspace_id, ? FROM customer_sessions WHERE id = ?').bind(at, id),
  ]);
  const row = await db.prepare('SELECT user_id, workspace_id FROM customer_sessions WHERE id = ?').bind(id)
    .first<{ user_id: string; workspace_id: string }>();
  if (!row) throw new HttpError(401, 'Sign in to continue', 'unauthorized');
  customerCookie(c, token);
  return { workspaceId: row.workspace_id, sessionId: id, userId: row.user_id, via: 'session' };
}

export async function sessionInfo(db: D1Database, auth: Auth) {
  const workspace = await one<Workspace>(db, 'SELECT * FROM workspaces WHERE id = ? AND sample = 0', auth.workspaceId);
  const user = await one<{ id: string; email: string }>(db, 'SELECT id, email FROM customer_users WHERE id = ?', auth.userId);
  if (!workspace || !user) throw new HttpError(401, 'Sign in to continue', 'unauthorized');
  const onboarding = await db.prepare('SELECT completed_at FROM company_onboarding WHERE workspace_id = ?').bind(auth.workspaceId).first<{ completed_at: string | null }>();
  const counters = await db.prepare('SELECT runs_used, tavily_used FROM judge_sessions WHERE id = ?').bind(auth.sessionId).first<{ runs_used: number; tavily_used: number }>();
  return { authenticated: true as const, user, session_id: auth.sessionId!, workspace_id: workspace.id, workspace,
    onboarding_complete: !!onboarding?.completed_at, caps: { runs: CAPS.runs, tavily: CAPS.tavily, agent_turns_per_min: CAPS.agentTurnsPerMin }, runs_used: counters?.runs_used ?? 0, tavily_used: counters?.tavily_used ?? 0 };
}

/** Used by long-lived agent transports after their opening HTTP request has finished. */
export async function isCustomerSessionActive(db: D1Database, session: string, workspace: string): Promise<boolean> {
  return !!await db.prepare(`SELECT s.id FROM customer_sessions s JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    JOIN workspaces w ON w.id = s.workspace_id AND w.sample = 0
    WHERE s.id = ? AND s.workspace_id = ? AND s.expires_at > ? AND s.revoked_at IS NULL`).bind(session, workspace, Date.now()).first();
}
