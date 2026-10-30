import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

type Status = ConstructorParameters<typeof HttpError>[0];
const KNOWN = new Set<number>([400, 401, 403, 404, 409, 429, 500, 501, 502]);

export interface HubCaller { workspaceId: string; sessionId: string | null }

/** Call the workspace's AgentHub over its internal HTTP surface (see AgentHub.fetch). */
export function hubFetch(env: Env, who: HubCaller, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const stub = env.AGENT.get(env.AGENT.idFromName(who.workspaceId));
  return stub.fetch(`https://agent.internal${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'x-pv-workspace': who.workspaceId, 'x-pv-session': who.sessionId ?? '', 'content-type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** Like hubFetch, parses JSON and turns the hub's `{ error, code }` into an HttpError the router already maps. */
export async function hubJson<T>(env: Env, who: HubCaller, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await hubFetch(env, who, path, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new HttpError((KNOWN.has(res.status) ? res.status : 502) as Status, data.error ?? 'Agent unavailable', data.code ?? 'error');
  return data as T;
}
