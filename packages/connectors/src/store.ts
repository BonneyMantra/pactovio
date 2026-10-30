import { fromRow, newId, type ConnectorRule } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { DEFAULT_RULES, SAMPLE_USER_ID } from './catalog';

export type ConnectorStatusDb = 'available' | 'pending' | 'connected' | 'error';

export interface ConnectorRow {
  id: string;
  workspace_id: string;
  provider: string;
  status: ConnectorStatusDb;
  external_account_id: string | null;
  meta: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  connected_at: string | null;
}

export async function getConnector(env: Env, workspaceId: string, provider: string): Promise<ConnectorRow | null> {
  const r = await env.DB.prepare('SELECT * FROM connectors WHERE workspace_id = ? AND provider = ?').bind(workspaceId, provider).first<Record<string, unknown>>();
  return r ? normalize(fromRow<ConnectorRow>(r)) : null;
}

export async function listConnectors(env: Env, workspaceId: string): Promise<ConnectorRow[]> {
  const r = await env.DB.prepare('SELECT * FROM connectors WHERE workspace_id = ?').bind(workspaceId).all<Record<string, unknown>>();
  return r.results.map((x) => normalize(fromRow<ConnectorRow>(x)));
}

/** Rows connected to a Composio account, any workspace (webhook routing). */
export async function connectorsForAccount(env: Env, externalAccountId: string): Promise<ConnectorRow[]> {
  const r = await env.DB.prepare("SELECT * FROM connectors WHERE external_account_id = ? AND status = 'connected' ORDER BY workspace_id").bind(externalAccountId).all<Record<string, unknown>>();
  return r.results.map((x) => normalize(fromRow<ConnectorRow>(x)));
}

const normalize = (r: ConnectorRow): ConnectorRow => ({ ...r, meta: (r.meta && typeof r.meta === 'object' ? r.meta : {}) as ConnectorRow['meta'] });

/** A seeded demo row, not a real Composio connection. */
export const isSample = (r: ConnectorRow | null): boolean => !!r?.meta.sample;
/** Usable for real actions. */
export const isLive = (r: ConnectorRow | null): r is ConnectorRow => !!r && r.status === 'connected' && !!r.external_account_id && !isSample(r);

export const composioUserId = (r: ConnectorRow | null): string => (r?.meta.composio_user_id as string | undefined) ?? SAMPLE_USER_ID;

export async function saveConnector(
  env: Env, workspaceId: string, provider: string,
  patch: { status?: ConnectorStatusDb; external_account_id?: string | null; connected_at?: string | null; meta?: Record<string, unknown> },
): Promise<ConnectorRow> {
  const cur = await getConnector(env, workspaceId, provider);
  const meta = patch.meta ?? cur?.meta ?? {};
  const row = {
    id: cur?.id ?? newId('connector'), status: patch.status ?? cur?.status ?? 'available',
    external_account_id: patch.external_account_id === undefined ? (cur?.external_account_id ?? null) : patch.external_account_id,
    connected_at: patch.connected_at === undefined ? (cur?.connected_at ?? null) : patch.connected_at, meta,
  };
  await env.DB.prepare(
    `INSERT INTO connectors (id, workspace_id, provider, status, external_account_id, meta_json, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET status = excluded.status, external_account_id = excluded.external_account_id, meta_json = excluded.meta_json, connected_at = excluded.connected_at`,
  ).bind(row.id, workspaceId, provider, row.status, row.external_account_id, JSON.stringify(row.meta), row.connected_at).run();
  return { ...row, workspace_id: workspaceId, provider } as ConnectorRow;
}

/** Merge into meta.config (remembered folder id, project key, trigger id...). Re-reads the row so concurrent saves do not clobber. */
export async function saveConfig(env: Env, workspaceId: string, provider: string, patch: Record<string, unknown>): Promise<void> {
  const cur = await getConnector(env, workspaceId, provider);
  if (!cur) return;
  const config = { ...(cur.meta.config ?? {}), ...patch };
  for (const [k, v] of Object.entries(config)) if (v === null) delete config[k];
  await saveConnector(env, workspaceId, provider, { meta: { ...cur.meta, config } });
}

const ruleKey = (r: Pick<ConnectorRule, 'event' | 'action'>) => `${r.event}:${r.action}`;

/** Defaults merged with the workspace's overrides (matched by event + action). */
export function effectiveRules(provider: string, meta: Record<string, any> | undefined): ConnectorRule[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out = new Map<string, ConnectorRule>((DEFAULT_RULES[provider] ?? []).map((r) => [ruleKey(r), r]));
  for (const o of (meta?.rules ?? []) as ConnectorRule[]) out.set(ruleKey(o), { ...out.get(ruleKey(o)), ...o });
  return [...out.values()];
}
