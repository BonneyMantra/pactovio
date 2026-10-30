import { fromRow } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { REPLAYS } from '../replay';
import { ensureProfileEvidence } from './retrieve';
import { logStep } from './run-log';
import type { RunCtx, Stepper } from './types';
import { nowIso } from './util';
import type { CompanyProfile } from '@pactovio/contracts';

type Row = Record<string, string | number | null>;
export interface ReplayStep { purpose: string; model: string | null; status: 'ok' | 'error'; tokens_in: number; tokens_out: number; tokens_cached: number; ms: number; cost_usd: number; summary: string | null }
export interface ReplaySnapshot {
  tender_id: string; workspace_id: string; recorded_at: string; source_run_id: string;
  steps: ReplayStep[]; requirements: Row[]; verdicts: Row[]; answers: Row[];
}

const TABLES = { requirements: 'requirements', verdicts: 'verdicts', answers: 'answers' } as const;

/** Export a finished live run (its steps and the rows it wrote) so it can be bundled as the replay. */
export async function snapshotRun(env: Env, runId: string): Promise<ReplaySnapshot> {
  const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, string>>();
  if (!run) throw new Error(`run ${runId} not found`);
  const all = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<Row>()).results;
  const steps = (await all('SELECT purpose, model, status, tokens_in, tokens_out, tokens_cached, ms, cost_usd, summary FROM run_steps WHERE run_id = ? ORDER BY seq', runId)) as unknown as ReplayStep[];
  const ws = run.workspace_id!, t = run.subject_id!;
  return {
    tender_id: t, workspace_id: ws, recorded_at: run.started_at!, source_run_id: runId, steps,
    requirements: await all('SELECT * FROM requirements WHERE workspace_id = ? AND tender_id = ?', ws, t),
    verdicts: await all('SELECT * FROM verdicts WHERE workspace_id = ? AND tender_id = ?', ws, t),
    answers: await all("SELECT * FROM answers WHERE workspace_id = ? AND tender_id = ? AND status = 'draft'", ws, t),
  };
}

/** The recorded run to serve: the bundled snapshot of this workspace, else the seeded showcase run in D1. */
export async function findReplay(env: Env, workspaceId: string, tenderId: string, excludeRun?: string): Promise<{ snapshot: ReplaySnapshot | null; fallbackRunId: string | null }> {
  const bundled = REPLAYS[tenderId];
  if (bundled && bundled.workspace_id === workspaceId) return { snapshot: bundled, fallbackRunId: null };
  const r = await env.DB.prepare("SELECT id FROM runs WHERE workspace_id = ? AND subject_type = 'tender' AND subject_id = ? AND replay = 1 AND status = 'completed' AND id != ? ORDER BY started_at DESC LIMIT 1")
    .bind(workspaceId, tenderId, excludeRun ?? '').first<{ id: string }>();
  return { snapshot: null, fallbackRunId: r?.id ?? null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `runId` is the replay run: recorded verdicts point at it (the recorded source run does not exist in a fresh database). */
async function restore(env: Env, s: ReplaySnapshot, runId: string): Promise<void> {
  const w = await env.DB.prepare('SELECT profile_json FROM workspaces WHERE id = ?').bind(s.workspace_id).first<{ profile_json: string }>();
  if (w) await ensureProfileEvidence(env, s.workspace_id, JSON.parse(w.profile_json) as CompanyProfile);
  const stmts: D1PreparedStatement[] = [];
  for (const table of Object.values(TABLES)) stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND tender_id = ?${table === 'answers' ? " AND (status = 'draft' OR id LIKE 'ans_sample%')" : ''}`).bind(s.workspace_id, s.tender_id));
  for (const [key, table] of Object.entries(TABLES)) {
    for (const row of s[key as keyof typeof TABLES]) {
      if (key === 'verdicts') row.run_id = runId;
      const cols = Object.keys(row);
      stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((c) => row[c] ?? null)));
    }
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

/**
 * Replay: serves a recorded live run. The run row is labelled `replay`, its steps are the REAL recorded steps
 * (model, tokens, cached tokens, ms, cost) written out at a compressed pace, and the recorded matrix, verdicts and
 * drafts are restored. No model is called and nothing counts against a judge's fresh-run cap.
 */
export async function runReplay(rc: RunCtx, step: Stepper): Promise<void> {
  const { env } = rc;
  const { snapshot, fallbackRunId } = await findReplay(env, rc.workspaceId, rc.tenderId, rc.runId);
  await step('start', async () => {
    await env.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(rc.runId).run();
    await emit(env, rc.workspaceId, 'run.started', { run_id: rc.runId, tender_id: rc.tenderId, kind: 'pack_run', replay: true });
    return true;
  });
  const steps: ReplayStep[] = snapshot
    ? snapshot.steps
    : fallbackRunId
      ? (await env.DB.prepare('SELECT purpose, model, status, tokens_in, tokens_out, tokens_cached, ms, cost_usd, summary FROM run_steps WHERE run_id = ? ORDER BY seq').bind(fallbackRunId).all<Record<string, unknown>>()).results.map((r) => fromRow<ReplayStep>(r))
      : [];
  await step('replay-label', async () => {
    await logStep(env, rc.runId, rc.workspaceId, { purpose: 'Replay of a recorded live run', model: '', status: 'ok', tokensIn: 0, tokensOut: 0, tokensCached: 0, ms: 0, costUsd: 0, summary: `The steps below are the real steps of the run recorded ${snapshot?.recorded_at ?? 'earlier'}; nothing is re-executed.` });
    return true;
  });
  for (const [i, s] of steps.entries()) {
    await step(`replay-step-${i + 1}`, async () => {
      await sleep(Math.min(700, Math.round(s.ms / 30)));
      await logStep(env, rc.runId, rc.workspaceId, { purpose: s.purpose, model: s.model ?? '', status: s.status, tokensIn: s.tokens_in, tokensOut: s.tokens_out, tokensCached: s.tokens_cached, ms: s.ms, costUsd: s.cost_usd, summary: s.summary ?? undefined });
      return true;
    });
  }
  if (snapshot) await step('restore', async () => { await restore(env, snapshot, rc.runId); return true; });
  await step('finish', async () => {
    await env.DB.prepare("UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?").bind(nowIso(), rc.runId).run();
    await emit(env, rc.workspaceId, 'run.completed', { run_id: rc.runId, tender_id: rc.tenderId, status: 'completed', replay: true });
    return true;
  });
}
