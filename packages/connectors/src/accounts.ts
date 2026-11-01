import { HttpError, type ConnectorCatalogItem } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { PROVIDERS, providerSpec, type ProviderSpec } from './catalog';
import type { ConnectedAccountInfo } from './composio';
import { composioFor, makeCtx, type Deps } from './runtime';
import { PROVIDER_ACTIONS } from './providers';
import { connectorsForAccount, effectiveRules, getConnector, isLive, isSample, listConnectors, saveConnector, type ConnectorRow } from './store';

import { workspaceUserId, tokenHash } from './identity';
import { completeOAuth, requireOAuthSession, saveOAuthState, safeReturn, stateToken } from './oauth';

const SYNC_TTL_S = 20;

async function authConfigId(env: Env, spec: ProviderSpec, deps: Deps): Promise<string> {
  const name = `pactovio-${spec.toolkit}`;
  const cacheKey = `cx:ac:${spec.toolkit}`;
  const cached = await env.CACHE.get(cacheKey).catch(() => null);
  if (cached) return cached;
  const c = composioFor(env, deps);
  let id = await c.findAuthConfig(name);
  if (!id) {
    if (!spec.managedAuth) {
      throw new HttpError(409, `${spec.name} needs our own OAuth app in Composio first (auth config "${name}"). ${spec.ownApp ?? ''}`.trim(), 'needs_setup');
    }
    id = await c.createManagedAuthConfig(spec.toolkit, name);
  }
  await env.CACHE.put(cacheKey, id, { expirationTtl: 3600 }).catch(() => undefined);
  return id;
}

/** Lane: connectors. Composio hosted-auth redirect URL for a provider; the user returns to /api/connectors/callback. */
export async function connectUrl(
  env: Env, workspaceId: string, provider: string, opts: { origin?: string; redirectTo?: string; sessionId?: string; state?: string } = {}, deps: Deps = {},
): Promise<string> {
  const spec = providerSpec(provider);
  if (!spec) throw new HttpError(404, `Unknown connector ${provider}`, 'not_found');
  const origin = opts.origin ?? 'https://pactovio.pages.dev';
  const redirectTo = safeReturn(opts.redirectTo);
  if (!opts.sessionId) throw new HttpError(403, 'A customer session is required', 'forbidden');
  const cur = await getConnector(env, workspaceId, provider);
  const userId = await workspaceUserId(env, workspaceId);
  await requireOAuthSession(env, workspaceId, opts.sessionId);
  if (userId === 'pactovio-demo') throw new HttpError(403, 'Sample connections are read-only', 'forbidden');

  // Outlook Calendar rides on the Outlook login: reuse it when it is already connected.
  if (spec.sharesAccountWith) {
    const base = await getConnector(env, workspaceId, spec.sharesAccountWith);
    if (isLive(base)) {
      await markConnected(env, workspaceId, provider, { id: base.external_account_id!, label: base.meta.account_label ?? null });
      return redirectTo;
    }
    return connectUrl(env, workspaceId, spec.sharesAccountWith, opts, deps);
  }

  if (env.ENVIRONMENT === 'production' && env.COMPOSIO_CALLBACK_VERIFIER_ENABLED !== 'true') throw new HttpError(409, 'Configure the Composio callback verifier before connecting customers', 'needs_setup');
  const acId = await authConfigId(env, spec, deps);
  const callback = new URL('/api/connectors/callback', origin);
  const state = opts.state ?? stateToken();
  callback.searchParams.set('state', state);
  const link = await composioFor(env, deps).createLink({ authConfigId: acId, userId, callbackUrl: callback.toString() });
  await saveOAuthState(env, { state, workspace: workspaceId, session: opts.sessionId, provider, account: link.connectedAccountId, user: userId, back: redirectTo });
  await saveConnector(env, workspaceId, provider, {
    status: 'pending',
    meta: { ...(cur && !isSample(cur) ? cur.meta : {}), sample: undefined, composio_user_id: userId, pending: { state_hash: await tokenHash(state), connected_account_id: link.connectedAccountId, redirect_to: redirectTo, started_at: new Date().toISOString() } },
  });
  await env.CACHE.delete(`cx:sync:${workspaceId}`).catch(() => undefined);
  return link.redirectUrl;
}

/** Mark a provider connected (and its shared-account sibling), then register the mailbox trigger for email providers. */
export async function markConnected(env: Env, workspaceId: string, provider: string, acct: { id: string; label: string | null }, deps: Deps = {}, owner = false): Promise<void> {
  const cur = await getConnector(env, workspaceId, provider);
  // `owner` marks the workspace that completed the connect flow; sync never shares an owned account with other workspaces.
  const meta = { ...(cur && !isSample(cur) ? cur.meta : {}), account_label: acct.label, composio_user_id: await workspaceUserId(env, workspaceId), ...(owner ? { owner: true } : {}) };
  delete (meta as Record<string, unknown>).pending;
  delete (meta as Record<string, unknown>).sample;
  await saveConnector(env, workspaceId, provider, { status: 'connected', external_account_id: acct.id, connected_at: new Date().toISOString(), meta });
  const sibling = PROVIDERS.find((p) => p.sharesAccountWith === provider);
  if (sibling) {
    const s = await getConnector(env, workspaceId, sibling.provider);
    await saveConnector(env, workspaceId, sibling.provider, { status: 'connected', external_account_id: acct.id, connected_at: new Date().toISOString(), meta: { ...(s && !isSample(s) ? s.meta : {}), account_label: acct.label, composio_user_id: meta.composio_user_id, ...(owner ? { owner: true } : {}) } });
  }
  if (provider === 'gmail' || provider === 'outlook') await watchInbox(env, workspaceId, provider, deps);
}

/** Register the new-mail trigger for this workspace (best effort; the connect flow must not fail on it). */
export async function watchInbox(env: Env, workspaceId: string, provider: 'gmail' | 'outlook' | string, deps: Deps = {}): Promise<{ ok: boolean; error?: string }> {
  const row = await getConnector(env, workspaceId, provider);
  if (!isLive(row)) return { ok: false, error: 'not connected' };
  try {
    await PROVIDER_ACTIONS[provider]!.watch_inbox!.run({}, makeCtx(env, row, deps));
    const latest = await getConnector(env, workspaceId, provider);
    if (latest?.meta.trigger_error) await saveConnector(env, workspaceId, provider, { meta: { ...latest.meta, trigger_error: undefined } });
    return { ok: true };
  } catch {
    const error = 'Inbox trigger could not be registered; reconnect or retry shortly';
    const latest = await getConnector(env, workspaceId, provider);
    if (latest) await saveConnector(env, workspaceId, provider, { meta: { ...latest.meta, trigger_error: error } });
    return { ok: false, error };
  }
}

/** GET /connectors/callback: Composio redirects here after OAuth. Returns where to send the browser. */
export async function completeCallback(
  env: Env, q: { session_uri?: string; state?: string; w?: string; p?: string; status?: string; connected_account_id?: string }, deps: Deps = {}, sessionId?: string,
): Promise<{ redirect: string; ok: boolean }> {
  return completeOAuth(env, q, deps, sessionId, (workspace, provider, acct) => markConnected(env, workspace, provider, acct, deps, true));
}

/**
 * Adopt Composio connections made outside Pactovio's own flow (dashboard, Opus in the browser): list the ACTIVE accounts of the
 * workspace's Composio user and reflect them in `connectors`. Seeded sample rows are not real and fall back to `available`.
 * Cached for 20 s so the catalogue stays cheap.
 */
export async function syncConnectors(env: Env, workspaceId: string, deps: Deps = {}, force = false): Promise<void> {
  if (!env.COMPOSIO_API_KEY) return;
  if (!force && (await env.CACHE.get(`cx:sync:${workspaceId}`).catch(() => null))) return;
  const rows = await listConnectors(env, workspaceId);
  const expectedUser = await workspaceUserId(env, workspaceId);
  const userIds = [expectedUser];
  let accounts: ConnectedAccountInfo[];
  try {
    accounts = await composioFor(env, deps).listConnectedAccounts({ userIds, statuses: ['ACTIVE'] });
  } catch {
    return; // Composio unreachable: keep what we have
  }
  const ownedElsewhere = new Set((await env.DB.prepare("SELECT external_account_id FROM connectors WHERE workspace_id != ? AND status = 'connected' AND json_extract(meta_json, '$.owner') = 1")
    .bind(workspaceId).all<{ external_account_id: string | null }>()).results.map((r) => r.external_account_id).filter((x): x is string => !!x));
  for (const spec of PROVIDERS) {
    const row = rows.find((r) => r.provider === spec.provider) ?? null;
    const uid = expectedUser;
    if (uid !== 'pactovio-demo' && row?.status === 'pending') continue;
    const found = accounts.find((a) => a.status === 'ACTIVE' && a.toolkit === spec.toolkit && a.userId === uid
      && (uid === 'pactovio-demo' || (row?.meta.owner && row.external_account_id === a.id)));
    // An account another workspace connected itself belongs to that workspace only (its mail, chat and files).
    const acct = found && !ownedElsewhere.has(found.id) && (expectedUser === 'pactovio-demo' || (row?.meta.owner && row.external_account_id === found.id)) ? found : undefined;
    if (found && !acct && row?.status === 'connected' && row.external_account_id === found.id && !row.meta.owner) {
      await saveConnector(env, workspaceId, spec.provider, { status: 'available', external_account_id: null, connected_at: null, meta: { composio_user_id: row.meta.composio_user_id, rules: row.meta.rules } });
      continue;
    }
    if (acct && !(row?.status === 'connected' && row.external_account_id === acct.id && !isSample(row))) {
      const trigger = row?.meta.config?.trigger;
      await markConnected(env, workspaceId, spec.provider, { id: acct.id, label: acct.label }, deps).catch(() => undefined);
      if (trigger && (spec.provider === 'gmail' || spec.provider === 'outlook')) await watchInbox(env, workspaceId, spec.provider, deps);
    } else if (acct && row && (spec.provider === 'gmail' || spec.provider === 'outlook') && (row.meta.trigger_error || !row.meta.config?.trigger)) {
      await watchInbox(env, workspaceId, spec.provider, deps);
    } else if (!acct && row && (isSample(row) || (row.status === 'connected' && row.external_account_id))) {
      await saveConnector(env, workspaceId, spec.provider, { status: 'available', external_account_id: null, connected_at: null, meta: { ...row.meta, sample: undefined, config: row.meta.config } });
    }
  }
  await env.CACHE.put(`cx:sync:${workspaceId}`, '1', { expirationTtl: SYNC_TTL_S }).catch(() => undefined);
}

/** Lane: connectors. Disconnect a provider; the Composio account is deleted only when no other workspace still uses it. */
export async function disconnectProvider(env: Env, workspaceId: string, provider: string, deps: Deps = {}): Promise<void> {
  const spec = providerSpec(provider);
  if (!spec) throw new HttpError(404, `Unknown connector ${provider}`, 'not_found');
  const row = await getConnector(env, workspaceId, provider);
  if (!row) return;
  const acct = row.external_account_id;
  const trigger = row.meta.config?.trigger as { id?: string } | undefined;
  const c = composioFor(env, deps);
  if (trigger?.id) await c.deleteTrigger(trigger.id).catch(() => undefined);
  const pendingAccount = (row.meta.pending as { connected_account_id?: string } | undefined)?.connected_account_id;
  if (pendingAccount) await c.deleteConnectedAccount(pendingAccount).catch(() => undefined); // an abandoned Connect Link
  const config = { ...(row.meta.config ?? {}) };
  delete config.trigger;
  await saveConnector(env, workspaceId, provider, { status: 'available', external_account_id: null, connected_at: null, meta: { composio_user_id: row.meta.composio_user_id, config, rules: row.meta.rules } });
  for (const sib of PROVIDERS.filter((p) => p.sharesAccountWith === provider)) {
    const s = await getConnector(env, workspaceId, sib.provider);
    if (s?.external_account_id === acct) await saveConnector(env, workspaceId, sib.provider, { status: 'available', external_account_id: null, connected_at: null, meta: { composio_user_id: s.meta.composio_user_id, config: s.meta.config, rules: s.meta.rules } });
  }
  if (acct && !spec.sharesAccountWith && (await connectorsForAccount(env, acct)).length === 0) await c.deleteConnectedAccount(acct).catch(() => undefined);
  await env.CACHE.delete(`cx:sync:${workspaceId}`).catch(() => undefined);
}

/** The catalogue: every provider with live status, what Pactovio does with it, actions and effective rules. */
export async function buildCatalog(env: Env, workspaceId: string): Promise<ConnectorCatalogItem[]> {
  const rows = await listConnectors(env, workspaceId);
  return PROVIDERS.map((spec) => {
    const row: ConnectorRow | undefined = rows.find((r) => r.provider === spec.provider);
    const live = isLive(row ?? null);
    const status: ConnectorCatalogItem['status'] = live ? 'connected'
      : row && !isSample(row) && (row.status === 'pending' || row.status === 'error') ? row.status
      : spec.needsWorkAccount ? 'needs_work_account' : 'available';
    const setup = spec.needsWorkAccount ? 'Needs a Microsoft 365 work or school account; a personal outlook.com login cannot join a Team.'
      : !spec.managedAuth ? (spec.ownApp ?? 'Needs our own OAuth app registered in Composio.') : null;
    return {
      provider: spec.provider, name: spec.name, category: spec.category, description: spec.description, status,
      connected_at: live ? row!.connected_at : null, external_account_id: live ? row!.external_account_id : null,
      actions: spec.actions, what_it_does: spec.whatItDoes, toolkit: spec.toolkit, managed_auth: spec.managedAuth,
      setup_note: live ? (row!.meta.trigger_error ?? null) : setup, account_label: live ? ((row!.meta.account_label as string | undefined) ?? null) : null,
      rules: effectiveRules(spec.provider, row?.meta),
    };
  });
}
