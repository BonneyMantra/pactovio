import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '@pactovio/contracts/env';
import { buildSeed } from '../scripts/seed-build';

const root = resolve(__dirname, '..');

function statements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

/** Fresh local D1 (temp dir), migrated and seeded, plus a real Worker env from wrangler.toml bindings. */
export async function makeEnv(): Promise<{ env: Env; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: mkdtempSync(join(tmpdir(), 'pactovio-test-')) } });
  // Tests replay many recorded model calls; production keeps the default $0.25/day cap (budget.test.ts covers the cap).
  const env = { ...proxy.env, ENVIRONMENT: 'development', MODEL_DAILY_CAP_USD: '1000' } as Env;
  const sql = readFileSync(join(root, 'migrations/0001_init.sql'), 'utf8');
  for (const s of [...statements(sql), ...statements(buildSeed())]) await env.DB.prepare(s).run();
  return { env, dispose: () => proxy.dispose() };
}
