import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { providerSpec } from './catalog';
import { composioFor, type Deps } from './runtime';
import { getConnector, settlePendingConnector } from './store';
import { safeReturn, stateToken, tokenHash, workspaceUserId } from './identity';

export async function requireOAuthSession(env: Env, workspace: string, session: string): Promise<void> {
  const now = Date.now();
  const valid = await env.DB.prepare(`SELECT s.id FROM customer_sessions s JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    JOIN workspaces w ON w.id = s.workspace_id AND w.sample = 0
    WHERE s.id = ? AND s.workspace_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).bind(session, workspace, now).first();
  if (!valid) throw new HttpError(403, 'A customer session is required', 'forbidden');
}

export async function saveOAuthState(env: Env, data: { state: string; workspace: string; session: string; provider: string; account: string; user: string; back: string }) {
  await requireOAuthSession(env, data.workspace, data.session);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO connector_oauth_states (state_hash, workspace_id, session_id, provider, account_id, user_id, redirect_to, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(await tokenHash(data.state), data.workspace, data.session, data.provider, data.account, data.user, safeReturn(data.back), now + 600000).run();
}

export { stateToken, safeReturn };

/** One atomic consume, bound to the initiating session; callback query IDs never confer authority. */
export async function completeOAuth(
  env: Env, q: { session_uri?: string; state?: string; connected_account_id?: string; status?: string }, deps: Deps, session: string | undefined,
  connected: (workspace: string, provider: string, acct: { id: string; label: string | null }, stateHash: string) => Promise<boolean>,
): Promise<{ redirect: string; ok: boolean }> {
  const failed = { redirect: '/app#/connections?status=failed', ok: false };
  if (!session || !q.state || !/^[a-f0-9]{64}$/.test(q.state)) return failed;
  const now = Date.now();
  const state = await env.DB.prepare(`UPDATE connector_oauth_states SET consumed_at = ?
    WHERE state_hash = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ?
    AND EXISTS (SELECT 1 FROM customer_sessions s JOIN workspace_members m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
      WHERE s.id = connector_oauth_states.session_id AND s.workspace_id = connector_oauth_states.workspace_id AND s.revoked_at IS NULL AND s.expires_at > ?)
    RETURNING *`).bind(now, await tokenHash(q.state), session, now, now)
    .first<{ workspace_id: string; provider: string; account_id: string; user_id: string; redirect_to: string }>();
  if (!state) return failed;
  const done = (ok: boolean) => ({ ok, redirect: `${safeReturn(state.redirect_to)}?connector=${encodeURIComponent(state.provider)}&status=${ok ? 'success' : 'failed'}` });
  const row = await getConnector(env, state.workspace_id, state.provider);
  // A newer attempt supersedes the previous flow; do not overwrite it.
  if (!row || row.meta.pending?.state_hash !== await tokenHash(q.state)) return done(false);
  try {
    if (env.COMPOSIO_CALLBACK_VERIFIER_ENABLED === 'true') {
      if (!q.session_uri) throw new Error('identity verification required');
      const verified = await composioFor(env, deps).completeAuth(state.user_id, q.session_uri);
      if (verified.connected_account_id !== state.account_id || verified.toolkit_slug !== providerSpec(state.provider)?.toolkit) throw new Error('account mismatch');
    }
    const acct = await composioFor(env, deps).getConnectedAccount(state.account_id);
    if ((q.connected_account_id && q.connected_account_id !== state.account_id) || acct.id !== state.account_id || acct.status !== 'ACTIVE'
      || acct.toolkit !== providerSpec(state.provider)?.toolkit || acct.userId !== state.user_id
      || state.user_id !== await workspaceUserId(env, state.workspace_id)) throw new Error('account mismatch');
    if (!await connected(state.workspace_id, state.provider, { id: acct.id, label: acct.label }, await tokenHash(q.state))) return done(false);
    await env.CACHE.delete(`cx:sync:${state.workspace_id}`).catch(() => undefined);
    return done(true);
  } catch {
    await settlePendingConnector(env, state.workspace_id, state.provider, await tokenHash(q.state), { status: 'error', account: null,
      meta: { last_error: 'Connection could not be verified; reconnect to try again' } });
    return done(false);
  }
}
