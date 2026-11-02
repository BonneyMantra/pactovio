import { Hono } from 'hono';
import { CompanyInput, HttpError, OnboardingPatch } from '@pactovio/contracts';
import { customerAuth } from '../lib/customer-session';
import { readOnboarding } from '../lib/onboarding-state';
import type { AppEnv } from '../lib/types';
import { registerOnboardingTools } from './onboarding-tools';

export const onboardingRoutes = new Hono<AppEnv>();
const read = readOnboarding;
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
  const data: Record<string, unknown> = { ...(patch.company ?? {}) };
  if (patch.person) data.person = patch.person;
  if (patch.goals) data.goals = patch.goals;
  if (patch.setup?.stage) data.setup = { version: 2, stage: patch.setup.stage };
  if (patch.profile) {
    const { confirmed_at, ...rest } = patch.profile;
    // The confirmation time is the server's, never a client-supplied claim.
    data.profile = confirmed_at === undefined ? rest : { ...rest, confirmed_at: confirmed_at === null ? null : new Date().toISOString() };
  }
  if (patch.results?.organize) {
    const counted = await db.prepare('SELECT COUNT(*) AS n FROM products WHERE workspace_id = ?').bind(ws).first<{ n: number }>();
    data.results = { organize: { ...patch.results.organize, product_count: counted?.n ?? 0, at: new Date().toISOString() } };
  }
  await db.prepare(`UPDATE company_onboarding SET data_json = json_patch(data_json, ?),
    settings_json = json_patch(settings_json, ?), updated_at = ? WHERE workspace_id = ?`)
    .bind(JSON.stringify(data), JSON.stringify(patch.settings ?? {}), new Date().toISOString(), ws).run();
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
/** v2 completion. Also completes v1 (COALESCE) so a fresh user is no longer gated; never resets an earlier completion. */
onboardingRoutes.post('/setup/complete', async (c) => {
  const ws = c.get('auth').workspaceId, db = c.env.DB, now = new Date().toISOString();
  if (!CompanyInput.safeParse((await read(db, ws)).company).success) {
    throw new HttpError(409, 'Add your company name, country, segment and at least one capability before finishing setup.', 'company_incomplete');
  }
  await applyProfile(db, ws);
  await db.prepare(`UPDATE company_onboarding SET data_json = json_patch(data_json, json_object('setup', json_object('version', 2, 'stage', 'ready',
      'completed_at', COALESCE(json_extract(data_json, '$.setup.completed_at'), ?)))),
    completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE workspace_id = ?`).bind(now, now, now, ws).run();
  return c.json(await read(db, ws));
});
registerOnboardingTools(onboardingRoutes);
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
