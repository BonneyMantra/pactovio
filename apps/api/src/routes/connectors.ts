import { z } from 'zod';
import { endpoints, HttpError } from '@pactovio/contracts';
import {
  buildCatalog, connectUrl, completeCallback, disconnectProvider, EVENT_ACTIONS, getConnector, PROVIDER_ACTIONS, providerSpec, runAction,
  saveConnector, syncConnectors,
} from '@pactovio/connectors';
import type { Handler, Register } from '../lib/router';

/** Judge sessions are anonymous and share one set of connected test accounts: they may try a connector but not replace or remove a live one. */
const requireOwner = (via: string, env: { ENVIRONMENT?: string }) => {
  if (via === 'session' && env.ENVIRONMENT === 'production') throw new HttpError(403, 'This connection is shared by the public demo; use an API key to change it', 'forbidden');
};

const TEST_CAP_PER_HOUR = 20;

const known = (id: string) => {
  if (!providerSpec(id)) throw new HttpError(404, `Unknown connector ${id}`, 'not_found');
  return id;
};

export const register: Register = (r) => {
  r.on(endpoints.listConnectors, async ({ env, workspaceId }) => {
    await syncConnectors(env, workspaceId);
    return { items: await buildCatalog(env, workspaceId) };
  });

  const connect: Handler<typeof endpoints.connectConnector> = async ({ c, env, auth, workspaceId, params, body }) => {
    const provider = known(params.id);
    const cur = await getConnector(env, workspaceId, provider);
    if (cur?.status === 'connected' && !cur.meta.sample) requireOwner(auth.via, env);
    const redirect_url = await connectUrl(env, workspaceId, provider, { origin: new URL(c.req.url).origin, redirectTo: body.redirect_to });
    return { redirect_url };
  };
  r.on(endpoints.connectConnector, connect);

  r.on(endpoints.disconnectConnector, async ({ env, auth, workspaceId, params }) => {
    requireOwner(auth.via, env);
    await disconnectProvider(env, workspaceId, known(params.id));
    return { ok: true };
  });

  r.on(endpoints.testConnector, async ({ env, auth, workspaceId, params, body }) => {
    const provider = known(params.id);
    if (!PROVIDER_ACTIONS[provider]?.[body.action]) throw new HttpError(400, `${provider} has no action "${body.action}". Available: ${Object.keys(PROVIDER_ACTIONS[provider] ?? {}).join(', ')}`, 'validation');
    const key = `cx:test:${auth.sessionId ?? workspaceId}:${new Date().toISOString().slice(0, 13)}`;
    const used = Number((await env.CACHE.get(key)) ?? 0);
    if (used >= TEST_CAP_PER_HOUR) throw new HttpError(429, `Test actions are capped at ${TEST_CAP_PER_HOUR} per hour`, 'rate_limited');
    await env.CACHE.put(key, String(used + 1), { expirationTtl: 3700 });
    return runAction(env, workspaceId, provider, body.action, (body.input ?? {}) as Record<string, unknown>);
  });

  r.on(endpoints.setConnectorRules, async ({ env, auth, workspaceId, params, body }) => {
    const provider = known(params.id);
    requireOwner(auth.via, env);
    const bad = body.rules.find((x) => !EVENT_ACTIONS[x.action]);
    if (bad) throw new HttpError(400, `Unknown rule action "${bad.action}". Available: ${Object.keys(EVENT_ACTIONS).join(', ')}`, 'validation');
    const cur = await getConnector(env, workspaceId, provider);
    await saveConnector(env, workspaceId, provider, { meta: { ...(cur?.meta ?? {}), rules: body.rules } });
    return { rules: body.rules };
  });

  // Composio sends the browser back here after OAuth (not part of the typed contract: a redirect, not JSON).
  r.app.get('/connectors/callback', async (c) => {
    const q = z.object({ w: z.string().optional(), p: z.string().optional(), status: z.string().optional(), connected_account_id: z.string().optional() }).parse(c.req.query());
    const res = await completeCallback(c.env, q);
    return c.redirect(res.redirect, 302);
  });
};
