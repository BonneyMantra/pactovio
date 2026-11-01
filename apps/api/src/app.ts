import { Hono } from 'hono';
import { buildOpenApi } from '@pactovio/contracts';
import { errorResponse, Router, type Register } from './lib/router';
import type { AppEnv } from './lib/types';
import * as health from './routes/health';
import * as workspaces from './routes/workspaces';
import * as today from './routes/today';
import * as tenders from './routes/tenders';
import * as runs from './routes/runs';
import * as buyers from './routes/buyers';
import * as evidence from './routes/evidence';
import * as intakes from './routes/intakes';
import * as design from './routes/design';
import * as quotes from './routes/quotes';
import * as connectors from './routes/connectors';
import * as webhooks from './routes/webhooks';
import * as apikeys from './routes/apikeys';
import * as ics from './routes/ics';
import * as agent from './routes/agent';
import * as billing from './routes/billing';
import * as limits from './routes/limits';
import * as events from './routes/events';
import * as ingest from './routes/ingest';
import { inboundWebhooks } from './routes/inbound-webhooks';
import { mcpRoutes } from './routes/mcp';
import { devRoutes } from './routes/dev';
import { customerAuthRoutes } from './routes/customer-auth';
import { onboardingRoutes } from './routes/onboarding';
import { integrationRoutes } from './routes/integrations';

/** Add a route module here. Each module exports `register(r)` and is mounted on both /api (session) and /v1 (API key). */
export const modules: Register[] = [
  health, workspaces, today, tenders, runs, buyers, evidence, intakes, design, quotes, connectors, webhooks,
  apikeys, ics, agent, billing, limits, events, ingest,
].map((m) => m.register);

export function buildApp() {
  const app = new Hono<AppEnv>();
  const api = new Router('session');
  const v1 = new Router('apikey');
  for (const reg of modules) { reg(api); reg(v1); }

  app.route('/api/auth', customerAuthRoutes);
  app.route('/api/onboarding', onboardingRoutes);
  app.route('/api/integrations', integrationRoutes);
  app.use('/api/*', async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
  app.route('/api', api.app);
  app.use('/v1/*', async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
  app.route('/v1', v1.app);
  app.get('/v1/openapi.json', (c) => c.json(buildOpenApi({ servers: [new URL(c.req.url).origin] })));
  app.route('/', ics.icsRoutes);
  app.route('/', inboundWebhooks);
  app.route('/', mcpRoutes);
  app.route('/', devRoutes);

  app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));
  app.onError((e, c) => errorResponse(c, e));
  return { app, api, v1 };
}

