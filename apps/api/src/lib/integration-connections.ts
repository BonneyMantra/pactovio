import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { HttpError } from '@pactovio/contracts';
import { ComposioError } from '@pactovio/connectors';
import { isCustomerSessionActive } from './customer-session';
import { randomToken, sha256Hex } from './db';
import { connectionAvailability, existingHostedConfig, integrationClient, nativeToolkit, isOAuthScheme, setupRequired } from './integration-provider';
import { conflict, Id, Slug, unavailable } from './integration-input';
export const ConnectInput = z.object({ return_path: z.enum(['/app#/onboarding', '/app#/connections']).default('/app#/connections') }).strict();
export interface Connection { id: string; workspace_id: string; toolkit: string; account_id: string | null; status: string; attempt_hash: string | null; updated_at: string }
export const workspaceUser = (workspace: string) => `pactovio-workspace-${workspace}`;
export async function ownConnection(env: Env, workspace: string, id: string): Promise<Connection> {
  const row = await env.DB.prepare('SELECT * FROM integration_connections WHERE id = ? AND workspace_id = ?').bind(Id.parse(id), workspace).first<Connection>();
  if (!row) throw new HttpError(404, 'Connection not found', 'not_found');
  return row;
}
export async function verifiedAccount(env: Env, row: Connection) {
  if (!row.account_id || row.status !== 'active') throw new HttpError(409, 'Reconnect this integration before reading it.', 'connection_required');
  try {
    const account = await integrationClient(env).getConnectedAccount(row.account_id);
    if (account.id !== row.account_id || account.toolkit !== row.toolkit || account.status !== 'ACTIVE' || account.userId !== workspaceUser(row.workspace_id)) throw new Error('Account mismatch');
    return account;
  } catch { throw new HttpError(409, 'This source account could not be verified. Reconnect to continue.', 'connection_required'); }
}
export async function listConnections(env: Env, workspace: string) {
  const rows = await env.DB.prepare('SELECT id, toolkit, status, updated_at FROM integration_connections WHERE workspace_id = ? ORDER BY toolkit').bind(workspace).all();
  return { items: rows.results, status_source: 'last_local_checkpoint', live_verification: 'performed_before_each_read_and_approval' };
}
export async function startConnection(env: Env, workspace: string, session: string, slug: string, origin: string, input: z.infer<typeof ConnectInput>) {
  if (!await isCustomerSessionActive(env.DB, session, workspace)) throw new HttpError(401, 'Sign in to connect an integration', 'unauthorized');
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || env.ENVIRONMENT === 'production' && url.protocol !== 'https:' || env.PUBLIC_ORIGIN && origin !== env.PUBLIC_ORIGIN) throw new HttpError(403, 'Invalid connection origin', 'origin_forbidden');
  const toolkit = await nativeToolkit(env, Slug.parse(slug));
  if ((await connectionAvailability(env, toolkit)).connection.availability !== 'ready') setupRequired();
  const config = await existingHostedConfig(env, toolkit); if (!config) setupRequired();
  const state = randomToken(32), hash = await sha256Hex(state), now = Date.now(), at = new Date(now).toISOString();
  const id = `icn_${randomToken(16)}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO integration_connections(id,workspace_id,toolkit,status,attempt_hash,updated_at) VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(workspace_id,toolkit) DO UPDATE SET status='pending',attempt_hash=excluded.attempt_hash,updated_at=excluded.updated_at`)
      .bind(id, workspace, slug, hash, at),
    env.DB.prepare(`INSERT INTO integration_oauth_states(state_hash,connection_id,workspace_id,session_id,toolkit,auth_scheme,origin,return_path,expires_at)
      SELECT ?,id,workspace_id,?,?,?,?, ?,? FROM integration_connections WHERE workspace_id=? AND toolkit=? AND attempt_hash=?`)
      .bind(hash, session, slug, config!.auth_scheme, origin, input.return_path, now + 600000, workspace, slug, hash),
  ]);
  let createdAccount: string | null = null;
  try {
    const result = await integrationClient(env).createLink({ authConfigId: config!.id, userId: workspaceUser(workspace),
      callbackUrl: `${origin}/api/integrations/workflows/verifier?state=${state}` });
    const redirect = new URL(result.redirectUrl);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || !Id.safeParse(result.connectedAccountId).success) throw new Error('Invalid link');
    createdAccount = result.connectedAccountId;
    const updated = await env.DB.prepare(`UPDATE integration_oauth_states SET account_id=?,initiation_complete=1 WHERE state_hash=?`)
      .bind(result.connectedAccountId, hash).run();
    if (!updated.meta.changes) conflict();
    const row = await env.DB.prepare("SELECT s.connection_id FROM integration_oauth_states s JOIN integration_connections c ON c.id=s.connection_id WHERE s.state_hash=? AND c.attempt_hash=s.state_hash AND c.status='pending'").bind(hash).first<{ connection_id: string }>();
    if (!row) conflict();
    return { state, connection_id: row!.connection_id, redirect_url: redirect.href, expires_in: 600 };
  } catch (error) {
    if (error instanceof ComposioError && error.status >= 400 && error.status < 500) {
      await env.DB.prepare('UPDATE integration_oauth_states SET initiation_complete=1 WHERE state_hash=? AND account_id IS NULL').bind(hash).run();
    }
    if (createdAccount) {
      const current = await env.DB.prepare('SELECT status FROM integration_connections WHERE workspace_id=? AND toolkit=?').bind(workspace, slug).first<{ status: string }>();
      const attempt = await env.DB.prepare('SELECT consumed_at FROM integration_oauth_states WHERE state_hash=? AND workspace_id=?').bind(hash, workspace).first<{ consumed_at: number | null }>();
      if (current?.status === 'disconnected' || attempt?.consumed_at) {
        try { await removeLateAccount(env, workspace, slug, hash, createdAccount); }
        catch { /* local access stays revoked; disconnect remains explicitly retryable */ }
      }
    }
    await env.DB.prepare("UPDATE integration_connections SET status='error',updated_at=? WHERE workspace_id=? AND toolkit=? AND attempt_hash=?")
      .bind(new Date().toISOString(), workspace, slug, hash).run();
    if (error instanceof HttpError) throw error;
    unavailable();
  }
}
async function removeLateAccount(env: Env, workspace: string, slug: string, hash: string, accountId: string) {
  const client = integrationClient(env);
  try {
    const account = await client.getConnectedAccount(accountId);
    if (account.id !== accountId || account.toolkit !== slug || account.userId !== workspaceUser(workspace)) throw new Error('Wrong account');
    await client.deleteConnectedAccount(accountId);
  } catch (error) { if (!(error instanceof ComposioError && error.status === 404)) throw error; }
  await env.DB.prepare('UPDATE integration_oauth_states SET account_id=NULL,consumed_at=COALESCE(consumed_at,?) WHERE state_hash=? AND workspace_id=? AND account_id=?')
    .bind(Date.now(), hash, workspace, accountId).run();
}
interface OAuthState { state_hash: string; connection_id: string; workspace_id: string; session_id: string; toolkit: string; account_id: string; auth_scheme: string; origin: string; return_path: string }
export const CallbackInput = z.object({ state: z.string().regex(/^[a-f0-9]{64}$/).optional(), session_uri: z.string().min(1).max(4096).optional(),
  status: z.string().max(80).optional(), connected_account_id: Id.optional() }).strict();
/** Also callable by the coordinator's existing verifier dispatcher. No callback-query identity is trusted. */
export async function completeIntegrationOAuth(env: Env, session: string, workspace: string, origin: string, cookie: string | undefined, query: z.infer<typeof CallbackInput>) {
  const failed = { ok: false, redirect: '/app#/connections?status=failed' };
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie) || query.state && query.state !== cookie || env.COMPOSIO_CALLBACK_VERIFIER_ENABLED !== 'true') return failed;
  const hash = await sha256Hex(cookie), now = Date.now();
  const state = await env.DB.prepare(`SELECT s.* FROM integration_oauth_states s JOIN integration_connections c ON c.id=s.connection_id
    WHERE s.state_hash=? AND s.session_id=? AND s.workspace_id=? AND s.origin=? AND s.expires_at>? AND s.consumed_at IS NULL
    AND c.attempt_hash=s.state_hash AND c.status='pending'`).bind(hash, session, workspace, origin, now).first<OAuthState>();
  if (!state || !state.account_id || !await isCustomerSessionActive(env.DB, session, workspace)) return failed;
  try {
    const client = integrationClient(env), user = workspaceUser(workspace);
    // Verify before consuming: a late callback from an older attempt must not consume the newer cookie's state.
    if (isOAuthScheme(state.auth_scheme)) {
      if (!query.session_uri) return failed;
      const result = await client.completeAuth(user, query.session_uri);
      if (result.connected_account_id !== state.account_id || result.toolkit_slug !== state.toolkit) return failed;
    } else if (!query.state || query.state !== cookie) return failed;
    if (query.connected_account_id && query.connected_account_id !== state.account_id) return failed;
    const account = await client.getConnectedAccount(state.account_id);
    if (account.id !== state.account_id || account.toolkit !== state.toolkit || account.status !== 'ACTIVE' || account.userId !== user) return failed;
    const token = randomToken(16), at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO integration_transaction_guard(token,valid) SELECT ?, CASE WHEN EXISTS(
        SELECT 1 FROM integration_oauth_states s JOIN integration_connections c ON c.id=s.connection_id
        JOIN customer_sessions cs ON cs.id=s.session_id JOIN workspace_members m ON m.user_id=cs.user_id AND m.workspace_id=cs.workspace_id
        WHERE s.state_hash=? AND s.consumed_at IS NULL AND s.expires_at>? AND c.attempt_hash=s.state_hash AND c.status='pending'
        AND cs.workspace_id=s.workspace_id AND cs.revoked_at IS NULL AND cs.expires_at>?) THEN 1 ELSE 0 END`).bind(token, hash, Date.now(), Date.now()),
      env.DB.prepare('UPDATE integration_oauth_states SET consumed_at=? WHERE state_hash=?').bind(Date.now(), hash),
      env.DB.prepare("UPDATE integration_connections SET account_id=?,status='active',attempt_hash=NULL,updated_at=? WHERE id=? AND attempt_hash=?")
        .bind(account.id, at, state.connection_id, hash),
      env.DB.prepare('DELETE FROM integration_transaction_guard WHERE token=?').bind(token),
    ]);
    const back = ConnectInput.parse({ return_path: state.return_path }).return_path;
    return { ok: true, redirect: `${back}?toolkit=${encodeURIComponent(state.toolkit)}&status=success` };
  } catch { return failed; }
}
export async function disconnectConnection(env: Env, workspace: string, id: string) {
  const row = await ownConnection(env, workspace, id);
  // Invalidate callbacks/read leases before awaiting the provider. Preserve the owned ID for recoverable remote cleanup.
  await env.DB.batch([
    env.DB.prepare("UPDATE integration_connections SET status='disconnected',attempt_hash=NULL,updated_at=? WHERE id=? AND workspace_id=?")
      .bind(new Date().toISOString(), id, workspace),
    env.DB.prepare('UPDATE integration_oauth_states SET consumed_at=COALESCE(consumed_at,?) WHERE connection_id=? AND workspace_id=? AND initiation_complete=0')
      .bind(Date.now(), id, workspace),
  ]);
  const attempts = await env.DB.prepare('SELECT account_id FROM integration_oauth_states WHERE connection_id=? AND workspace_id=? AND account_id IS NOT NULL ORDER BY expires_at DESC LIMIT 20')
    .bind(id, workspace).all<{ account_id: string }>();
  const candidates = [...new Set([row.account_id, ...attempts.results.map(a => a.account_id)].filter((a): a is string => !!a))];
  let failed = false;
  for (const accountId of candidates) {
    try {
      const client = integrationClient(env), acct = await client.getConnectedAccount(accountId);
      if (acct.id !== accountId || acct.toolkit !== row.toolkit || acct.userId !== workspaceUser(workspace)) throw new Error('Wrong account');
      await client.deleteConnectedAccount(acct.id);
      await env.DB.prepare('UPDATE integration_oauth_states SET account_id=NULL,consumed_at=COALESCE(consumed_at,?) WHERE connection_id=? AND workspace_id=? AND account_id=?').bind(Date.now(), id, workspace, accountId).run();
    } catch (error) {
      if (error instanceof ComposioError && error.status === 404) await env.DB.prepare('UPDATE integration_oauth_states SET account_id=NULL,consumed_at=COALESCE(consumed_at,?) WHERE connection_id=? AND workspace_id=? AND account_id=?').bind(Date.now(), id, workspace, accountId).run();
      else { failed = true; break; }
    }
  }
  const more = await env.DB.prepare('SELECT 1 FROM integration_oauth_states WHERE connection_id=? AND workspace_id=? AND account_id IS NOT NULL LIMIT 1').bind(id, workspace).first();
  const initiating = await env.DB.prepare('SELECT 1 FROM integration_oauth_states WHERE connection_id=? AND workspace_id=? AND initiation_complete=0 LIMIT 1').bind(id, workspace).first();
  if (failed || more || initiating) throw new HttpError(503, 'Disconnected locally. Retry disconnect to finish removing the source connection.', 'disconnect_pending');
  await env.DB.prepare("UPDATE integration_connections SET account_id=NULL WHERE id=? AND workspace_id=? AND status='disconnected'")
    .bind(id, workspace).run();
  return { ok: true };
}
