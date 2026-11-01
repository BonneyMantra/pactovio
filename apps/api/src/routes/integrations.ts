import { Hono } from 'hono';
import type { AppEnv } from '../lib/types';
import { customerAuth } from '../lib/customer-session';
import { CatalogQuery, integrationCatalog } from '../lib/integration-catalog';

export const integrationRoutes = new Hono<AppEnv>();
integrationRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  c.set('auth', await customerAuth(c));
  await next();
});
integrationRoutes.get('/catalog', async c => c.json(await integrationCatalog(c.env, CatalogQuery.parse(c.req.query()))));
