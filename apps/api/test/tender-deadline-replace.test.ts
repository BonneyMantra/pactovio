import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { saveTenderDates } from '../src/lib/opportunity-deadlines';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>, ws: string;
beforeAll(async () => { ({ env, dispose } = await makeEnv()); ws = (await customerFixture(env)).workspace; }, 60000);
afterAll(async () => dispose?.());

describe('saveTenderDates', () => {
  it('replaces a moved open date for the same tender and kind instead of duplicating it', async () => {
    const date = (due_at: string) => ({ kind: 'submission', title: 'Tender submission deadline', due_at, excerpt: `Due ${due_at}` });
    await saveTenderDates(env.DB, ws, 'tnd_moved', 'Pipette robot', [date('2026-11-24')]);
    await saveTenderDates(env.DB, ws, 'tnd_moved', 'Pipette robot', [date('2026-12-01')]);
    await saveTenderDates(env.DB, ws, 'tnd_moved', 'Pipette robot', [date('2026-12-01')]);
    const rows = await env.DB.prepare("SELECT due_at FROM workspace_deadlines WHERE workspace_id = ? AND tender_id = 'tnd_moved' AND status = 'open'").bind(ws).all();
    expect(rows.results).toEqual([{ due_at: '2026-12-01' }]);
  });
});
