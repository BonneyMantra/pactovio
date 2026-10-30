import { HttpError, type ConnectorCatalogItem } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { PROVIDERS, providerSpec, SAMPLE_USER_ID, type ProviderSpec } from './catalog';
import type { ConnectedAccountInfo } from './composio';
import { composioFor, makeCtx, type Deps } from './runtime';
import { PROVIDER_ACTIONS } from './providers';
import { connectorsForAccount, effectiveRules, getConnector, isLive, isSample, listConnectors, saveConnector, type ConnectorRow } from './store';

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

const safeRedirect = (to: string | undefined, origin: string): string => {
  if (!to) return '/';
  if (to.startsWith('/') && !to.startsWith('//')) return to;
  try { return new URL(to).origin === origin ? to : '/'; } catch { return '/'; }
};

/** Lane: connectors. Composio hosted-auth redirect URL for a provider; the user returns to /api/connectors/callback. */
export async function connectUrl(
  env: Env, workspaceId: string, provider: string, opts: { origin?: string; redirectTo?: string } = {}, deps: Deps = {},
): Promise<string> {
  const spec = providerSpec(provider);
  if (!spec) throw new HttpError(404, `Unknown connector ${provider}`, 'not_found');
  const origin = opts.origin ?? 'https://pactovio.pages.dev';
  const redirectTo = safeRedirect(opts.redirectTo, origin);
  const cur = await getConnector(env, workspaceId, provider);
  const userId = (cur?.meta.composio_user_id as string | undefined) ?? SAMPLE_USER_ID;

  // Outlook Calendar rides on the Outlook login: reuse it when it is already connected.
  if (spec.sharesAccountWith) {
    const base = await getConnector(env, workspaceId, spec.sharesAccountWith);
    if (isLive(base)) {
      await markConnected(env, workspaceId, provider, { id: base.external_account_id!, label: base.meta.account_label ?? null });
      return redirectTo;
    }
    return connectUrl(env, workspaceId, spec.sharesAccountWith, opts, deps);
  }

  const acId = await authConfigId(env, spec, deps);
  const callback = new URL('/api/connectors/callback', origin);
  callback.searchParams.set('w', workspaceId);
  callback.searchParams.set('p', provider);
  const link = await composioFor(env, deps).createLink({ authConfigId: acId, userId, callbackUrl: callback.toString() });
  await saveConnector(env, workspaceId, provider, {
    status: 'pending',
    meta: { ...(cur && !isSample(cur) ? cur.meta : {}), sample: undefined, composio_user_id: userId, pending: { connected_account_id: link.connectedAccountId, redirect_to: redirectTo, started_at: new Date().toISOString() } },
  });
  await env.CACHE.delete(`cx:sync:${workspaceId}`).catch(() => undefined);
  return link.redirectUrl;
}

/** Mark a provider connected (and its shared-account sibling), then register the mailbox trigger for email providers. */
export async function markConnected(env: Env, workspaceId: string, provider: string, acct: { id: string; label: string | null }, deps: Deps = {}): Promise<void> {
  const cur = await getConnector(env, workspaceId, provider);
  const meta = { ...(cur && !isSample(cur) ? cur.meta : {}), account_label: acct.label, composio_user_id: cur?.meta.composio_user_id ?? SAMPLE_USER_ID };
  delete (meta as Record<string, unknown>).pending;
  delete (meta as Record<string, unknown>).sample;
  await saveConnector(env, workspaceId, provider, { status: 'connected', external_account_id: acct.id, connected_at: new Date().toISOString(), meta });
  const sibling = PROVIDERS.find((p) => p.sharesAccountWith === provider);
  if (sibling) {
    const s = await getConnector(env, workspaceId, sibling.provider);
    await saveConnector(env, workspaceId, sibling.provider, { status: 'connected', external_account_id: acct.id, connected_at: new Date().toISOString(), meta: { ...(s && !isSample(s) ? s.meta : {}), account_label: acct.label, composio_user_id: meta.composio_user_id } });
  }
  if (provider === 'gmail' || provider === 'outlook') await watchInbox(env, workspaceId, provider, deps);
}

/** Register the new-mail trigger for this workspace (best effort; the connect flow must not fail on it). */
export async function watchInbox(env: Env, workspaceId: string, provider: 'gmail' | 'outlook' | string, deps: Deps = {}): Promise<{ ok: boolean; error?: string }> {
  const row = await getConnector(env, workspaceId, provider);
  if (!isLive(row)) return { ok: false, error: 'not connected' };
  try {
    await PROVIDER_ACTIONS[provider]!.watch_inbox!.run({}, makeCtx(env, row, deps));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GET /connectors/callback: Composio redirects here after OAuth. Returns where to send the browser. */
export async function completeCallback(
  env: Env, q: { w?: string; p?: string; status?: string; connected_account_id?: string }, deps: Deps = {},
): Promise<{ redirect: string; ok: boolean }> {
  const row = q.w && q.p ? await getConnector(env, q.w, q.p) : null;
  const pending = row?.meta.pending as { connected_account_id?: string; redirect_to?: string } | undefined;
  const back = pending?.redirect_to ?? '/';
  const sep = back.includes('?') ? '&' : '?';
  const done = (ok: boolean) => ({ ok, redirect: `${back}${sep}connector=${encodeURIComponent(q.p ?? '')}&status=${ok ? 'success' : 'failed'}` });
  // Callback query parameters alone are not proof: the account must be the one this workspace started.
  if (!row || !q.w || !q.p || !pending?.connected_account_id || pending.connected_account_id !== q.connected_account_id) return done(false);
  const acct = await composioFor(env, deps).getConnectedAccount(pending.connected_account_id);
  if (acct.status !== 'ACTIVE') {
    await saveConnector(env, q.w, q.p, { status: 'error', meta: { ...row.meta, pending: undefined, last_error: `Composio reports ${acct.status}` } });
    return done(false);
  }
  await markConnected(env, q.w, q.p, { id: acct.id, label: acct.label }, deps);
  await env.CACHE.delete(`cx:sync:${q.w}`).catch(() => undefined);
  return done(true);
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
  const userIds = [...new Set([SAMPLE_USER_ID, ...rows.map((r) => r.meta.composio_user_id as string | undefined).filter((u): u is string => !!u)])];
  let accounts: ConnectedAccountInfo[];
  try {
    accounts = await composioFor(env, deps).listConnectedAccounts({ userIds, statuses: ['ACTIVE'] });
  } catch {
    return; // Composio unreachable: keep what we have
  }
  for (const spec of PROVIDERS) {
    const row = rows.find((r) => r.provider === spec.provider) ?? null;
    const uid = (row?.meta.composio_user_id as string | undefined) ?? SAMPLE_USER_ID;
    const acct = accounts.find((a) => a.toolkit === spec.toolkit && a.userId === uid);
    if (acct && !(row?.status === 'connected' && row.external_account_id === acct.id && !isSample(row))) {
      const trigger = row?.meta.config?.trigger;
      await markConnected(env, workspaceId, spec.provider, { id: acct.id, label: acct.label }, deps).catch(() => undefined);
      if (trigger && (spec.provider === 'gmail' || spec.provider === 'outlook')) await watchInbox(env, workspaceId, spec.provider, deps);
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
      setup_note: live ? null : setup, account_label: live ? ((row!.meta.account_label as string | undefined) ?? null) : null,
      rules: effectiveRules(spec.provider, row?.meta),
    };
  });
}
