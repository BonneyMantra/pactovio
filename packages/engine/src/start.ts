import { chargeCredits, CREDIT_COSTS, refundCredits } from '@pactovio/billing';
import { HttpError, newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { CAPS, consumeFreshRun, refundFreshRun } from './caps';
import { findReplay } from './replay';
import { nowIso } from './util';

export interface PackRunParams { runId: string; workspaceId: string; tenderId: string; replay?: boolean }

/** Credits for a fresh pack read by size: small up to 120 pages, medium up to 400, large above. */
export function packCredits(pages: number): number {
  return pages <= 120 ? CREDIT_COSTS.pack_read_small : pages <= 400 ? CREDIT_COSTS.pack_read_medium : CREDIT_COSTS.pack_read_large;
}

/**
 * Create the run row and start PackRunWorkflow.
 * Replay: a judge session with no explicit `replay` flag gets the recorded run when one exists (free, no model call).
 * Fresh run: consumes one of the session's 2 runs, charges credits (real workspaces only; sample workspaces are shared),
 * and takes the single global fresh-run slot (the Token Factory quota is shared with other products), all atomically.
 * One run per tender and workspace at a time.
 */
export async function startPackRunImpl(env: Env, input: { workspaceId: string; tenderId: string; sessionId?: string; replay?: boolean }): Promise<string> {
  const db = env.DB;
  if (!(await db.prepare('SELECT 1 AS x FROM tenders WHERE id = ?').bind(input.tenderId).first())) throw new HttpError(404, 'Tender not found', 'not_found');
  const ws = await db.prepare('SELECT sample FROM workspaces WHERE id = ?').bind(input.workspaceId).first<{ sample: number }>();
  if (!ws) throw new HttpError(404, 'Workspace not found', 'not_found');
  const busy = await db.prepare("SELECT id FROM runs WHERE workspace_id = ? AND subject_type = 'tender' AND subject_id = ? AND status IN ('queued','running') AND started_at > ?")
    .bind(input.workspaceId, input.tenderId, new Date(Date.now() - 25 * 60_000).toISOString()).first<{ id: string }>();
  if (busy) throw new HttpError(409, `A run is already in progress for this tender (${busy.id})`, 'conflict');
  const recorded = await findReplay(env, input.workspaceId, input.tenderId);
  const hasReplay = !!(recorded.snapshot || recorded.fallbackRunId);
  const replay = input.replay ?? (!!input.sessionId && hasReplay);
  if (replay && !hasReplay) throw new HttpError(404, 'No recorded run to replay for this tender and workspace', 'not_found');

  const runId = newId('run');
  const insert = "INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at, replay)";
  let credits = 0;
  if (replay) {
    await db.prepare(`${insert} VALUES (?, ?, 'tender', ?, 'pack_run', 'queued', ?, 1)`).bind(runId, input.workspaceId, input.tenderId, nowIso()).run();
  } else {
    await consumeFreshRun(db, input.sessionId);
    try {
      if (ws.sample !== 1) {
        const pages = (await db.prepare('SELECT COALESCE(SUM(pages), 0) AS n FROM documents WHERE tender_id = ?').bind(input.tenderId).first<{ n: number }>())?.n ?? 0;
        credits = packCredits(pages);
        await chargeCredits(env, input.workspaceId, credits, 'pack_read', `run:${runId}`);
      }
      const slot = await db.prepare(
        `${insert} SELECT ?, ?, 'tender', ?, 'pack_run', 'queued', ?, 0 WHERE (SELECT COUNT(*) FROM runs WHERE kind = 'pack_run' AND replay = 0 AND status IN ('queued','running') AND started_at > ?) < ?`,
      ).bind(runId, input.workspaceId, input.tenderId, nowIso(), new Date(Date.now() - 25 * 60_000).toISOString(), CAPS.globalFreshRuns).run();
      if ((slot.meta.changes ?? 0) === 0) throw new HttpError(429, 'Another fresh pack run is in progress and the model quota is shared. Try again in a few minutes, or replay the recorded run.', 'cap_global');
    } catch (e) {
      await refundFreshRun(db, input.sessionId);
      if (credits) await refundCredits(env, input.workspaceId, credits, 'pack_read_refund', `refund:${runId}`);
      throw e;
    }
  }
  try {
    await env.PACK_RUN.create({ id: runId, params: { runId, workspaceId: input.workspaceId, tenderId: input.tenderId, replay } satisfies PackRunParams });
  } catch (e) {
    await db.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?").bind(nowIso(), runId).run();
    if (!replay) {
      await refundFreshRun(db, input.sessionId);
      if (credits) await refundCredits(env, input.workspaceId, credits, 'pack_read_refund', `refund:${runId}`);
    }
    throw new HttpError(502, `Could not start the workflow: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`, 'upstream');
  }
  return runId;
}
