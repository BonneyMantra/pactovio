/**
 * Re-write the verdicts of a finished local run: tsx scripts/reverdict.ts <runId> [persistDir]
 * Uses the local D1/R2 state of a `wrangler dev --persist-to <dir>` session (stop that server first).
 */
import { resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '@pactovio/contracts/env';
import { rerunVerdicts } from '../src';

const [runId, dir = '../../apps/api/.wrangler/state-b-engine'] = process.argv.slice(2);
if (!runId) throw new Error('usage: reverdict <runId> [persistDir]');
const proxy = await getPlatformProxy<Env>({ configPath: resolve(process.cwd(), '../../apps/api/wrangler.toml'), persist: { path: resolve(process.cwd(), dir, 'v3') } });
const env = { ...proxy.env, NEBIUS_API_KEY: process.env.NEBIUS_API_KEY } as Env;
const run = await env.DB.prepare('SELECT workspace_id, subject_id FROM runs WHERE id = ?').bind(runId).first<{ workspace_id: string; subject_id: string }>();
if (!run) throw new Error('run not found in this state dir');
const out = await rerunVerdicts({ env, runId, workspaceId: run.workspace_id, tenderId: run.subject_id });
process.stderr.write(JSON.stringify(out) + '\n');
await proxy.dispose();
