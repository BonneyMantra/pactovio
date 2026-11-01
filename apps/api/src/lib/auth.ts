import type { Context } from 'hono';
import { HttpError } from '@pactovio/contracts';
import { one, exec, nowIso, sha256Hex } from './db';
import { DEFAULT_WORKSPACE_ID, type Auth, type AppEnv } from './types';

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

export { customerAuth as sessionAuth } from './customer-session';

/** /v1: `Authorization: Bearer pk_...`, looked up by SHA-256. */
export async function apiKeyAuth(c: Context<AppEnv>): Promise<Auth> {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(pk_[A-Za-z0-9_]+)$/.exec(h);
  if (!m) throw new HttpError(401, 'Missing or malformed API key', 'unauthorized');
  const hash = await sha256Hex(m[1]!);
  const k = await one<{ id: string; workspace_id: string }>(c.env.DB, 'SELECT k.id, k.workspace_id FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id WHERE k.hash = ? AND w.sample = 0', hash);
  if (!k) throw new HttpError(401, 'Invalid API key', 'unauthorized');
  c.executionCtx.waitUntil(exec(c.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), k.id));
  return { workspaceId: k.workspace_id, sessionId: null, via: 'apikey' };
}
