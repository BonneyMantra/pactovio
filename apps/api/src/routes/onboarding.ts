import { Hono } from 'hono';
import { CompanyInput, CustomerSettings, HttpError, OnboardingPatch } from '@pactovio/contracts';
import { customerAuth } from '../lib/customer-session';
import type { AppEnv } from '../lib/types';

export const onboardingRoutes = new Hono<AppEnv>();
async function read(db: D1Database, workspace: string) {
  const row = await db.prepare('SELECT * FROM company_onboarding WHERE workspace_id = ?').bind(workspace)
    .first<{ data_json: string; settings_json: string; completed_at: string | null; updated_at: string }>();
  if (!row) throw new HttpError(404, 'Company setup not found', 'not_found');
  return { company: CompanyInput.partial().parse(JSON.parse(row.data_json)),
    settings: CustomerSettings.partial().parse(JSON.parse(row.settings_json)), completed_at: row.completed_at, updated_at: row.updated_at };
}
onboardingRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  c.set('auth', await customerAuth(c));
  await next();
});
onboardingRoutes.get('/', async (c) => c.json(await read(c.env.DB, c.get('auth').workspaceId)));
onboardingRoutes.patch('/', async (c) => {
  const patch = OnboardingPatch.parse(await c.req.json().catch(() => ({})));
  const ws = c.get('auth').workspaceId, db = c.env.DB;
  const old = await read(db, ws);
  // json_patch merges atomically, avoiding lost updates between tabs. Completed profiles must stay valid.
  if (old.completed_at) CompanyInput.parse({ ...old.company, ...patch.company });
  await db.prepare(`UPDATE company_onboarding SET data_json = json_patch(data_json, ?),
    settings_json = json_patch(settings_json, ?), updated_at = ? WHERE workspace_id = ?`)
    .bind(JSON.stringify(patch.company ?? {}), JSON.stringify(patch.settings ?? {}), new Date().toISOString(), ws).run();
  await applyProfile(db, ws);
  return c.json(await read(db, ws));
});
onboardingRoutes.post('/complete', async (c) => {
  const ws = c.get('auth').workspaceId;
  CompanyInput.parse((await read(c.env.DB, ws)).company);
  await applyProfile(c.env.DB, ws);
  await c.env.DB.prepare('UPDATE company_onboarding SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE workspace_id = ?')
    .bind(new Date().toISOString(), new Date().toISOString(), ws).run();
  return c.json(await read(c.env.DB, ws));
});
async function applyProfile(db: D1Database, ws: string) {
  // Derive only customer-supplied facts; do not invent evidence, headcount, insurance or catalogue entries.
  await db.prepare(`UPDATE workspaces SET name = COALESCE((SELECT json_extract(data_json, '$.name') FROM company_onboarding WHERE workspace_id = ?), name),
    segment = COALESCE((SELECT json_extract(data_json, '$.supplier_segment') FROM company_onboarding WHERE workspace_id = ?), segment),
    profile_json = json_patch(profile_json, (SELECT json_object(
      'legal_name', COALESCE(json_extract(data_json, '$.name'), ''),
      'hq', json_object('city', '', 'country', COALESCE(json_extract(data_json, '$.country'), '')),
      'capabilities', json(COALESCE(json_extract(data_json, '$.capabilities'), '[]')),
      'extra', json_object('website', json_extract(data_json, '$.website'))
    ) FROM company_onboarding WHERE workspace_id = ?)) WHERE id = ? AND sample = 0`).bind(ws, ws, ws, ws).run();
}
