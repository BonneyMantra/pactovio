import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HttpError, newId } from '@pactovio/contracts';
import { one, exec, nowIso, sha256Hex } from './db';
import { DEFAULT_WORKSPACE_ID, SESSION_COOKIE, type Auth, type AppEnv } from './types';

/** KV key (CACHE) naming the sample workspace new sessions land in; unset, unknown or non-sample falls back to DEFAULT_WORKSPACE_ID. */
export const DEFAULT_WORKSPACE_KEY = 'config:default_workspace';

export async function defaultWorkspaceId(env: AppEnv['Bindings']): Promise<string> {
  try {
    const id = await env.CACHE.get(DEFAULT_WORKSPACE_KEY);
    if (id && (await one<{ id: string }>(env.DB, 'SELECT id FROM workspaces WHERE id = ? AND sample = 1', id))) return id;
  } catch {
    // KV unavailable: use the built-in default
  }
  return DEFAULT_WORKSPACE_ID;
}

/** /api: anonymous judge session cookie `pv_s`, bound to a sample workspace. Created on first visit. */
export async function sessionAuth(c: Context<AppEnv>): Promise<Auth> {
  const db = c.env.DB;
  const existing = getCookie(c, SESSION_COOKIE);
  if (existing) {
    const s = await one<{ id: string; workspace_id: string }>(db, 'SELECT id, workspace_id FROM judge_sessions WHERE id = ?', existing);
    if (s) return { workspaceId: s.workspace_id, sessionId: s.id, via: 'session' };
  }
  const id = newId('session');
  const workspaceId = await defaultWorkspaceId(c.env);
  await exec(db, 'INSERT INTO judge_sessions (id, workspace_id, created_at) VALUES (?, ?, ?)', id, workspaceId, nowIso());
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, id, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 60 * 60 * 24 * 30 });
  return { workspaceId, sessionId: id, via: 'session' };
}

/** /v1: `Authorization: Bearer pk_...`, looked up by SHA-256. */
export async function apiKeyAuth(c: Context<AppEnv>): Promise<Auth> {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(pk_[A-Za-z0-9_]+)$/.exec(h);
  if (!m) throw new HttpError(401, 'Missing or malformed API key', 'unauthorized');
  const hash = await sha256Hex(m[1]!);
  const k = await one<{ id: string; workspace_id: string }>(c.env.DB, 'SELECT id, workspace_id FROM api_keys WHERE hash = ?', hash);
  if (!k) throw new HttpError(401, 'Invalid API key', 'unauthorized');
  c.executionCtx.waitUntil(exec(c.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), k.id));
  return { workspaceId: k.workspace_id, sessionId: null, via: 'apikey' };
}
