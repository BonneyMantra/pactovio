import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { TodayFeed } from '@pactovio/contracts';
import { buildApp } from '../../../apps/api/src/app';
import { makeEnv } from '../../../apps/api/test/helpers';
import { customerFixture } from '../../../apps/api/test/customer-fixture';
import { runNightlyScan } from '../src';

const fx = (n: string) => readFileSync(resolve(__dirname, 'fixtures', n), 'utf8');
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe('GET /api/today after a scan', () => {
  let env: Env;
  let dispose: () => Promise<void>;
  beforeAll(async () => ({ env, dispose } = await makeEnv()), 60_000);
  afterAll(async () => dispose?.());

  it('returns real matches ordered by fit then recency, hides dismissed and expired ones, and lists the scan intakes', async () => {
    const fetchFake = (async (u: string) => new Response(String(u).includes('ted.europa.eu') ? fx('ted-live.json') : fx('fts-ocds.json'))) as unknown as typeof fetch;
    const scores: Record<string, number> = { '102252': 99, '102124': 40 };
    await runNightlyScan(env, {
      fetch: fetchFake, packs: false, workspaceId: 'ws_harbour_digital', now: new Date('2026-08-01T00:00:00Z'),
      triage: async (_w, t) => ({ fit_score: scores[t.source_ref.split('-')[0]!] ?? 77, reason: `scored ${t.source_ref}`, door: 'tender' }),
    });
    const { app } = buildApp();
    const customer = await customerFixture(env, 'ws_harbour_digital');
    const res = await app.fetch(new Request('http://localhost/api/today', { headers: { cookie: customer.cookie } }), env, ctx);
    expect(res.status).toBe(200);
    const feed = TodayFeed.parse(await res.json());
    const fits = feed.top_matches.map((m) => m.match!.fit_score);
    expect(fits).toEqual([...fits].sort((a, b) => b - a));
    const refs = feed.top_matches.map((m) => m.tender.source_ref);
    expect(refs[0]).toBe('102252-2026'); // best fit first
    expect(refs).not.toContain('102124-2026'); // fit 40 is stored as dismissed, not shown
    expect(feed.top_matches.every((m) => m.match!.status !== 'dismissed')).toBe(true);
    expect(feed.intakes.some((i) => i.source === 'scan' && i.title.includes('London Luton'))).toBe(true);
    expect(feed.counts.new_matches).toBeGreaterThan(0);
  }, 60_000);
});
