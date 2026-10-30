import { newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import type { StepLogger, StepRecord } from '@pactovio/models';
import { nowIso } from './util';

/** Append one run_step (atomic seq), add its tokens/cost to the run, and emit `run.step`. */
export async function logStep(env: Env, runId: string, workspaceId: string, s: StepRecord): Promise<void> {
  const id = newId('step');
  await env.DB.prepare(
    `INSERT INTO run_steps (id, run_id, seq, at, purpose, model, status, tokens_in, tokens_out, tokens_cached, ms, cost_usd, summary)
     SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM run_steps WHERE run_id = ?`,
  ).bind(id, runId, nowIso(), s.purpose, s.model || null, s.status, s.tokensIn, s.tokensOut, s.tokensCached, s.ms, s.costUsd, s.summary ?? null, runId).run();
  await env.DB.prepare('UPDATE runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ? WHERE id = ?')
    .bind(s.tokensIn, s.tokensOut, s.costUsd, runId).run();
  await emit(env, workspaceId, 'run.step', { run_id: runId, purpose: s.purpose, model: s.model, status: s.status, ms: s.ms });
}

/** StepLogger for @pactovio/models calls. Errors while logging never break the model call. */
export function modelLogger(env: Env, runId: string, workspaceId: string, summarise?: (s: StepRecord) => string | undefined): StepLogger {
  return async (s) => {
    try {
      await logStep(env, runId, workspaceId, { ...s, summary: s.summary ?? summarise?.(s) });
    } catch (e) {
      console.error('run-log: step insert failed', e instanceof Error ? e.message : e);
    }
  };
}

/** Time and log a non-model piece of work (text extraction, rule evaluation) as a run_step. */
export async function timedStep<T>(env: Env, runId: string, workspaceId: string, purpose: string, fn: () => Promise<{ value: T; summary: string }>): Promise<T> {
  const t0 = Date.now();
  try {
    const { value, summary } = await fn();
    await logStep(env, runId, workspaceId, { purpose, model: '', status: 'ok', tokensIn: 0, tokensOut: 0, tokensCached: 0, ms: Date.now() - t0, costUsd: 0, summary });
    return value;
  } catch (e) {
    await logStep(env, runId, workspaceId, { purpose, model: '', status: 'error', tokensIn: 0, tokensOut: 0, tokensCached: 0, ms: Date.now() - t0, costUsd: 0, summary: e instanceof Error ? e.message.slice(0, 300) : 'error' });
    throw e;
  }
}
