import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { HttpError } from '@pactovio/contracts';
import type { AppEnv } from '../lib/types';
import { customerAuth } from '../lib/customer-session';
import { takeLimit } from '../lib/customer-security';
import { CallbackInput, ConnectInput, completeIntegrationOAuth, disconnectConnection, listConnections, startConnection } from '../lib/integration-connections';
import { toolkitDetail, toolkitOperations, OperationsQuery } from '../lib/integration-detail';
import { Slug, Id, ApproveInput, PreviewInput, RevisionInput, TableInput } from '../lib/integration-input';
import { SelectInput, jobStatus, readJob, selectedJob, stagedRows, tabularJob } from '../lib/integration-jobs';
import { freezePreview } from '../lib/integration-preview';
import { approvePreview } from '../lib/integration-approve';
export const UNIVERSAL_OAUTH_COOKIE = 'pv_integration_oauth';
async function body(c: Context<AppEnv>): Promise<unknown> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(400, 'Send a JSON request body.', 'validation');
  try { return await c.req.json(); } catch { throw new HttpError(400, 'Invalid JSON request.', 'validation'); }
}
export async function integrationVerifier(c: Context<AppEnv>) {
  const auth = await customerAuth(c), query = CallbackInput.parse(c.req.query());
  const origin = new URL(c.req.url).origin;
  if (c.env.PUBLIC_ORIGIN && origin !== c.env.PUBLIC_ORIGIN) throw new HttpError(403, 'Invalid callback origin.', 'origin_forbidden');
  const result = await completeIntegrationOAuth(c.env, auth.sessionId!, auth.workspaceId,
    origin, getCookie(c, UNIVERSAL_OAUTH_COOKIE), query);
  // A stale callback must preserve the newer attempt's cookie.
  if (result.ok) deleteCookie(c, UNIVERSAL_OAUTH_COOKIE, { path: '/api' });
  return c.redirect(result.redirect, 302);
}
/** Coordinator mounts this at /api/integrations/workflows; existing connectors remain untouched. */
export const integrationWorkflowRoutes = new Hono<AppEnv>();
const routes = integrationWorkflowRoutes;
routes.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid integration input.', code: 'validation' }, 400);
  if (error instanceof HttpError) return c.json({ error: error.message, code: error.code }, error.status);
  return c.json({ error: 'The integration could not complete this request. Try again.', code: 'integration_unavailable' }, 503);
});
routes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  c.set('auth', await customerAuth(c));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    z.object({}).strict().parse(c.req.query());
    await takeLimit(c.env.DB, `integration:${c.get('auth').workspaceId}`, 120, 3600);
  }
  await next();
});
routes.use('*', bodyLimit({ maxSize: 256000, onError: c => c.json({ error: 'The import request is too large.', code: 'body_too_large' }, 413) }));
routes.get('/toolkits/:slug', async c => {
  z.object({}).strict().parse(c.req.query());
  return c.json(await toolkitDetail(c.env, Slug.parse(c.req.param('slug'))));
});
routes.get('/toolkits/:slug/operations', async c => {
  const query = OperationsQuery.parse(c.req.query());
  return c.json(await toolkitOperations(c.env, Slug.parse(c.req.param('slug')), query.cursor));
});
routes.get('/connections', async c => { z.object({}).strict().parse(c.req.query()); return c.json(await listConnections(c.env, c.get('auth').workspaceId)); });
routes.post('/toolkits/:slug/connect', async c => {
  z.object({}).strict().parse(c.req.query());
  const auth = c.get('auth');
  const result = await startConnection(c.env, auth.workspaceId, auth.sessionId!, Slug.parse(c.req.param('slug')),
    c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin, ConnectInput.parse(await body(c)));
  setCookie(c, UNIVERSAL_OAUTH_COOKIE, result.state, { httpOnly: true, sameSite: 'Lax', path: '/api', maxAge: 600,
    secure: c.env.ENVIRONMENT !== 'development' || new URL(c.req.url).protocol === 'https:' });
  return c.json({ connection_id: result.connection_id, redirect_url: result.redirect_url, expires_in: result.expires_in });
});
routes.get('/verifier', integrationVerifier);
routes.post('/connections/:id/disconnect', async c => {
  z.object({}).strict().parse(c.req.query()); z.object({}).strict().parse(await body(c));
  return c.json(await disconnectConnection(c.env, c.get('auth').workspaceId, Id.parse(c.req.param('id'))));
});
routes.post('/imports/select', async c => c.json(await selectedJob(c.env, c.get('auth').workspaceId, SelectInput.parse(await body(c))), 201));
routes.post('/imports/tabular', async c => c.json(await tabularJob(c.env, c.get('auth').workspaceId, TableInput.parse(await body(c))), 201));
routes.get('/imports', async c => {
  z.object({}).strict().parse(c.req.query());
  const jobs = await c.env.DB.prepare('SELECT id,state,revision,toolkit,created_at,updated_at FROM integration_jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50')
    .bind(c.get('auth').workspaceId).all();
  return c.json({ items: jobs.results });
});
routes.get('/imports/:id', async c => { z.object({}).strict().parse(c.req.query()); return c.json(await jobStatus(c.env, c.get('auth').workspaceId, Id.parse(c.req.param('id')))); });
routes.get('/imports/:id/rows', async c => {
  const query = z.object({ offset: z.coerce.number().int().min(0).max(500).default(0) }).strict().parse(c.req.query());
  return c.json(await stagedRows(c.env, c.get('auth').workspaceId, Id.parse(c.req.param('id')), query.offset));
});
for (const action of ['read', 'resume']) routes.post(`/imports/:id/${action}`, async c => {
  const input = RevisionInput.parse(await body(c));
  return c.json(await readJob(c.env, c.get('auth').workspaceId, Id.parse(c.req.param('id')), input.revision, c.get('auth').sessionId!));
});
routes.post('/imports/:id/preview', async c => c.json(await freezePreview(c.env, c.get('auth').workspaceId, Id.parse(c.req.param('id')), PreviewInput.parse(await body(c)))));
routes.post('/imports/:id/approve', async c => c.json(await approvePreview(c.env, c.get('auth').workspaceId, Id.parse(c.req.param('id')), ApproveInput.parse(await body(c)), c.get('auth').sessionId!)));
