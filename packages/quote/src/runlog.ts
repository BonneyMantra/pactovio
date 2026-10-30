import { newId } from '@pactovio/contracts';
import type { StepRecord } from '@pactovio/models';

/** Logs a run and its model calls (run_steps) for a design-request match, so the UI can show the same step feed as a pack run. */
export async function startRun(db: D1Database, workspaceId: string, subjectId: string, kind = 'design_match') {
  const id = newId('run');
  await db.prepare("INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at) VALUES (?, ?, 'design_request', ?, ?, 'running', ?)").bind(id, workspaceId, subjectId, kind, new Date().toISOString()).run();
  let seq = 0;
  let tin = 0;
  let tout = 0;
  let cost = 0;
  return {
    runId: id,
    onStep: async (s: StepRecord) => {
      tin += s.tokensIn; tout += s.tokensOut; cost += s.costUsd;
      await db.prepare('INSERT INTO run_steps (id, run_id, seq, at, purpose, model, status, tokens_in, tokens_out, tokens_cached, ms, cost_usd, summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(newId('step'), id, ++seq, new Date().toISOString(), s.purpose, s.model, s.status, s.tokensIn, s.tokensOut, s.tokensCached, s.ms, s.costUsd, s.summary ?? null).run();
    },
    finish: async (status: 'completed' | 'failed') => {
      await db.prepare('UPDATE runs SET status = ?, finished_at = ?, tokens_in = ?, tokens_out = ?, cost_usd = ? WHERE id = ?').bind(status, new Date().toISOString(), tin, tout, cost, id).run();
    },
  };
}
