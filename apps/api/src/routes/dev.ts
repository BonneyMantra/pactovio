import { Hono } from 'hono';
import { endpointList } from '@pactovio/contracts';
import type { AppEnv } from '../lib/types';

/** Bare unstyled test pages, plain HTML. Lanes add pages next to this one under apps/api/src/dev/. */
export const devRoutes = new Hono<AppEnv>().get('/dev', (c) => c.redirect('/dev/', 302)).get('/dev/', (c) => {
  const items = endpointList
    .filter((e) => e.method === 'GET' && e.kind === 'json' && !e.path.includes('{'))
    .map((e) => `<li><a href="/api${e.path}">GET /api${e.path}</a> (${e.status})</li>`)
    .join('');
  return c.html(`<!doctype html><title>Pactovio dev</title><h1>Pactovio dev index</h1><p><a href="/v1/openapi.json">openapi.json</a></p><ul>${items}</ul>`);
});
