import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '@pactovio/contracts/env';
import { localStorageEnv } from './local-storage';
import { buildSeed } from '../scripts/seed-build';

const root = resolve(__dirname, '..');

function statements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

/** Fresh local D1 (temp dir), migrated and seeded, plus a real Worker env from wrangler.toml bindings. */
export async function makeEnv(): Promise<{ env: Env; dispose: () => Promise<void> }> {
  const proxy = process.env.PACTOVIO_TEST_SQLITE === '1' ? localStorageEnv() : await getPlatformProxy<Env>({ configPath: join(root, 'wrangler.toml'), persist: { path: mkdtempSync(join(tmpdir(), 'pactovio-test-')) } });
  // Tests replay many recorded model calls; production keeps the default $0.25/day cap (budget.test.ts covers the cap).
  const env = { ...proxy.env, ENVIRONMENT: 'development', PUBLIC_ORIGIN: undefined,
    NEBIUS_API_KEY: 'test-transport-only-not-a-real-key', MODEL_DAILY_CAP_USD: '1000' } as Env;
  const sql = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(root, 'migrations', f), 'utf8')).join('\n');
  for (const s of [...statements(sql), ...statements(buildSeed())]) await env.DB.prepare(s).run();
  return { env, dispose: () => proxy.dispose() };
}
