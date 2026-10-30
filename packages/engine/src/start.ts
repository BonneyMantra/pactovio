import { HttpError, newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { consumeFreshRun, refundFreshRun } from './caps';
import { findReplay } from './replay';
import { nowIso } from './util';

export interface PackRunParams { runId: string; workspaceId: string; tenderId: string; replay?: boolean }

/**
 * Create the run row and start PackRunWorkflow. A fresh run consumes one of the judge session's 2 fresh runs
 * (atomic UPDATE); a replay never does. One run per tender and workspace at a time.
 */
export async function startPackRunImpl(env: Env, input: { workspaceId: string; tenderId: string; sessionId?: string; replay?: boolean }): Promise<string> {
  const db = env.DB;
  if (!(await db.prepare('SELECT 1 AS x FROM tenders WHERE id = ?').bind(input.tenderId).first())) throw new HttpError(404, 'Tender not found', 'not_found');
  if (!(await db.prepare('SELECT 1 AS x FROM workspaces WHERE id = ?').bind(input.workspaceId).first())) throw new HttpError(404, 'Workspace not found', 'not_found');
  const busy = await db.prepare("SELECT id FROM runs WHERE workspace_id = ? AND subject_type = 'tender' AND subject_id = ? AND status IN ('queued','running') AND started_at > ?")
    .bind(input.workspaceId, input.tenderId, new Date(Date.now() - 25 * 60_000).toISOString()).first<{ id: string }>();
  if (busy) throw new HttpError(409, `A run is already in progress for this tender (${busy.id})`, 'conflict');
  const replay = !!input.replay;
  if (replay) {
    const r = await findReplay(env, input.workspaceId, input.tenderId);
    if (!r.snapshot && !r.fallbackRunId) throw new HttpError(404, 'No recorded run to replay for this tender and workspace', 'not_found');
  } else await consumeFreshRun(db, input.sessionId);
  const runId = newId('run');
  await db.prepare("INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at, replay) VALUES (?, ?, 'tender', ?, 'pack_run', 'queued', ?, ?)")
    .bind(runId, input.workspaceId, input.tenderId, nowIso(), replay ? 1 : 0).run();
  try {
    await env.PACK_RUN.create({ id: runId, params: { runId, workspaceId: input.workspaceId, tenderId: input.tenderId, replay } satisfies PackRunParams });
  } catch (e) {
    await db.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?").bind(nowIso(), runId).run();
    if (!replay) await refundFreshRun(db, input.sessionId);
    throw new HttpError(502, `Could not start the workflow: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`, 'upstream');
  }
  return runId;
}

