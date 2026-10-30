import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { ActionError, type ActionCtx, type ActionDef, type ActionOutput, type Input } from './actions';
import { providerSpec } from './catalog';
import { Composio } from './composio';
import { PROVIDER_ACTIONS } from './providers';
import { composioUserId, getConnector, isLive, saveConfig, type ConnectorRow } from './store';
import { mimeFor } from './util';

export interface Deps { fetch?: typeof fetch; now?: () => Date }

export const composioFor = (env: Env, deps: Deps = {}) => new Composio(env, deps.fetch ?? fetch);

/** Build the context an action runs in. Exposed so scripts and tests can drive actions with a fake `exec`. */
export function makeCtx(env: Env, row: ConnectorRow, deps: Deps = {}, over: Partial<ActionCtx> = {}): ActionCtx {
  const composio = composioFor(env, deps);
  const spec = providerSpec(row.provider);
  const who = { connectedAccountId: row.external_account_id ?? '', userId: composioUserId(row) };
  return {
    workspaceId: row.workspace_id, provider: row.provider, meta: row.meta,
    account: { id: who.connectedAccountId, userId: who.userId }, composio,
    exec: async (tool, args) => {
      const r = await composio.executeTool(tool, args, who);
      if (!r.successful) throw new ActionError(`${tool} failed: ${(r.error ?? 'unknown error').slice(0, 400)}`);
      return r.data;
    },
    proxy: (req) => composio.proxy(who, req),
    saveConfig: async (patch) => {
      await saveConfig(env, row.workspace_id, row.provider, patch);
      row.meta.config = { ...(row.meta.config ?? {}), ...patch };
    },
    stage: (tool, f) => composio.stageFile({ toolkit: spec?.toolkit ?? row.provider, tool, ...f }),
    now: deps.now ?? (() => new Date()),
    ...over,
  };
}

/** `input.r2_key` (+ optional `filename`) -> bytes from the FILES bucket, so storage connectors can upload what the engine produced. */
async function loadFile(env: Env, input: Input): Promise<ActionCtx['file']> {
  if (!input.r2_key) return undefined;
  const obj = await env.FILES.get(String(input.r2_key));
  if (!obj) throw new ActionError(`R2 object ${input.r2_key} not found`, 'bad_input');
  const filename = String(input.filename ?? String(input.r2_key).split('/').pop() ?? 'file');
  return { filename, mimetype: String(input.mimetype ?? obj.httpMetadata?.contentType ?? mimeFor(filename)), bytes: new Uint8Array(await obj.arrayBuffer()) };
}

/**
 * Lane: connectors. Run an action on a connected provider (slack.post_message, googlecalendar.create_event, ...).
 * Never throws for provider failures: `{ ok: false, output: { error, code } }`.
 */
export async function runAction(
  env: Env, workspaceId: string, provider: string, action: string, input: Record<string, unknown>, deps: Deps = {},
): Promise<{ ok: boolean; output?: unknown }> {
  const def = PROVIDER_ACTIONS[provider]?.[action];
  if (!providerSpec(provider)) throw new HttpError(404, `Unknown connector ${provider}`, 'not_found');
  if (!def) throw new HttpError(400, `${provider} has no action ${action}`, 'validation');
  const row = await getConnector(env, workspaceId, provider);
  if (!isLive(row)) return { ok: false, output: { error: `${provider} is not connected`, code: 'not_connected' } };
  try {
    const ctx = makeCtx(env, row, deps, { file: await loadFile(env, input) });
    const out: ActionOutput = await def.run(input, ctx);
    return { ok: true, output: out };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, output: { error: e.message, code: e.code } };
    throw e;
  }
}

export interface Exercise { ok: boolean; out?: ActionOutput | null; readback?: boolean | null; cleaned?: boolean | null; error?: string }

/** Run one action with a ready context, read the result back through Composio, clean it up. Used by the e2e script and exerciseAction. */
export async function exerciseDef(def: ActionDef, ctx: ActionCtx, input?: Input, extra?: (out: ActionOutput) => Promise<void>): Promise<Exercise> {
  let out: ActionOutput | null = null;
  try {
    out = await def.run(input ?? def.sample?.({ email: null }) ?? {}, ctx);
    const readback = def.readback ? await def.readback(out, ctx) : null;
    if (extra) await extra(out);
    let cleaned: boolean | null = null;
    if (def.cleanup) { try { await def.cleanup(out, ctx); cleaned = true; } catch { cleaned = false; } }
    return { ok: readback !== false && (!!out.id || def.readback === undefined), out, readback, cleaned };
  } catch (e) {
    if (out && def.cleanup) await def.cleanup(out, ctx).catch(() => undefined);
    return { ok: false, error: e instanceof Error ? e.message : String(e), out };
  }
}

/** Same against a workspace's stored connector row. */
export async function exerciseAction(env: Env, workspaceId: string, provider: string, action: string, input?: Input, deps: Deps = {}): Promise<Exercise> {
  const def = PROVIDER_ACTIONS[provider]?.[action];
  const row = await getConnector(env, workspaceId, provider);
  if (!def || !isLive(row)) return { ok: false, error: `${provider}.${action} unavailable or not connected` };
  return exerciseDef(def, makeCtx(env, row, deps), input);
}
