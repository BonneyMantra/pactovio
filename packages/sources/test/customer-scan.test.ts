import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { makeEnv } from '../../../apps/api/test/helpers';
import { customerFixture } from '../../../apps/api/test/customer-fixture';
import { fetchNotices, loadWorkspaces } from '../src/scan';

let env: Env, dispose: () => Promise<void>;
beforeAll(async () => ({ env, dispose } = await makeEnv()), 60000);
afterAll(async () => dispose?.());

it('spends no scheduled scan work on retained demos or incomplete customer onboarding', async () => {
  expect(await loadWorkspaces(env)).toEqual([]);
  const customer = await customerFixture(env);
  expect(await loadWorkspaces(env)).toEqual([]);
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; throw new Error('Unexpected source request'); };
  expect(await fetchNotices(await loadWorkspaces(env), { fetch })).toEqual({ tenders: [], errors: [] });
  expect(requests).toBe(0);
  await env.DB.prepare('UPDATE company_onboarding SET completed_at = ? WHERE workspace_id = ?')
    .bind(new Date().toISOString(), customer.workspace).run();
  expect((await loadWorkspaces(env)).map((w) => w.id)).toEqual([customer.workspace]);
  // An explicit internal diagnostic scan can still target retained sample data.
  expect((await loadWorkspaces(env, 'ws_harbour_digital')).map((w) => w.id)).toEqual(['ws_harbour_digital']);
});
