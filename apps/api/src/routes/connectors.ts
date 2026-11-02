import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { takeLimit } from '../lib/customer-security';
import { randomToken } from '../lib/db';
import type { Context } from 'hono';
import { z } from 'zod';
import { endpoints, HttpError } from '@pactovio/contracts';
import {
  buildCatalog, connectUrl, completeCallback, disconnectProvider, EVENT_ACTIONS, getConnector, PROVIDER_ACTIONS, providerSpec, runAction,
  saveConnector, syncConnectors,
} from '@pactovio/connectors';
import { sessionAuth } from '../lib/auth';
import type { Handler, Register } from '../lib/router';
import type { AppEnv } from '../lib/types';
import { integrationVerifier, UNIVERSAL_OAUTH_COOKIE } from './integration-workflows';

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
    if (!auth.sessionId || !auth.userId) throw new HttpError(403, 'Connect using a customer browser session', 'forbidden');
    const state = randomToken(32);
    const redirect_url = await connectUrl(env, workspaceId, provider, { origin: env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin, redirectTo: body.redirect_to, sessionId: auth.sessionId, state });
    deleteCookie(c, UNIVERSAL_OAUTH_COOKIE, { path: '/api' });
    setCookie(c, 'pv_oauth', state, { httpOnly: true, secure: env.ENVIRONMENT !== 'development' || new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/api/connectors', maxAge: 600 });
    return { redirect_url };
  };
  r.on(endpoints.connectConnector, connect);

  r.on(endpoints.disconnectConnector, async ({ env, auth, workspaceId, params }) => {
    await disconnectProvider(env, workspaceId, known(params.id));
    return { ok: true };
  });

  r.on(endpoints.testConnector, async ({ env, auth, workspaceId, params, body }) => {
    const provider = known(params.id);
    if (!PROVIDER_ACTIONS[provider]?.[body.action]) throw new HttpError(400, `${provider} has no action "${body.action}". Available: ${Object.keys(PROVIDER_ACTIONS[provider] ?? {}).join(', ')}`, 'validation');
    const key = `cx:test:${auth.sessionId ?? workspaceId}:${new Date().toISOString().slice(0, 13)}`;
    await takeLimit(env.DB, key, TEST_CAP_PER_HOUR, 3600);
    return runAction(env, workspaceId, provider, body.action, (body.input ?? {}) as Record<string, unknown>);
  });

  r.on(endpoints.setConnectorRules, async ({ env, auth, workspaceId, params, body }) => {
    const provider = known(params.id);
    const bad = body.rules.find((x) => !EVENT_ACTIONS[x.action]);
    if (bad) throw new HttpError(400, `Unknown rule action "${bad.action}". Available: ${Object.keys(EVENT_ACTIONS).join(', ')}`, 'validation');
    const cur = await getConnector(env, workspaceId, provider);
    await saveConnector(env, workspaceId, provider, { meta: { ...(cur?.meta ?? {}), rules: body.rules } });
    return { rules: body.rules };
  });

  // Composio sends the browser back here after OAuth (not part of the typed contract: a redirect, not JSON).
  const callback = async (c: Context<AppEnv>) => {
    if (getCookie(c, UNIVERSAL_OAUTH_COOKIE)) return integrationVerifier(c);
    const q = z.object({ state: z.string().regex(/^[a-f0-9]{64}$/).optional(), session_uri: z.string().min(1).max(4096).optional(),
      status: z.string().max(80).optional(), connected_account_id: z.string().max(200).optional() }).parse(c.req.query());
    const auth = await sessionAuth(c);
    const state = q.session_uri ? getCookie(c, 'pv_oauth') : q.state;
    const res = await completeCallback(c.env, { ...q, state }, {}, auth.sessionId!);
    deleteCookie(c, 'pv_oauth', { path: '/api/connectors' });
    return c.redirect(res.redirect, 302);
  };
  r.app.get('/connectors/callback', callback);
  r.app.get('/connectors/verifier', callback);
};
