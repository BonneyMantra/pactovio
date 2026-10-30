import { newId, type Tender } from '@pactovio/contracts';
import type { StepRecord } from '@pactovio/models';
import type { Env } from '@pactovio/contracts/env';

const UPSERT = `INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, value_eur, deadline, url, lots_json, published_at, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, source_ref) DO UPDATE SET
    deadline = CASE WHEN tenders.deadline IS NULL OR substr(tenders.deadline, 1, 10) != substr(excluded.deadline, 1, 10) THEN COALESCE(excluded.deadline, tenders.deadline) ELSE tenders.deadline END,
    raw_json = CASE WHEN json_extract(tenders.raw_json, '$.resource_id') IS NULL AND json_extract(excluded.raw_json, '$.resource_id') IS NOT NULL
      THEN json_patch(COALESCE(tenders.raw_json, '{}'), json_object('resource_id', json_extract(excluded.raw_json, '$.resource_id'), 'portal', json_extract(excluded.raw_json, '$.portal'), 'ted_publication_number', json_extract(excluded.raw_json, '$.ted_publication_number')))
      ELSE tenders.raw_json END`;

const CHUNK = 40;

/**
 * Insert new notices; an existing (source, source_ref) row keeps its id and content (only a changed deadline day
 * or a missing eTenders resource id is filled in). Returns the stored id of every notice and which were new.
 */
export async function upsertTenders(env: Env, tenders: Tender[]): Promise<{ id: string; isNew: boolean }[]> {
  const existing = new Map<string, string>();
  for (let i = 0; i < tenders.length; i += CHUNK) {
    const part = tenders.slice(i, i + CHUNK);
    const where = part.map(() => '(source = ? AND source_ref = ?)').join(' OR ');
    const res = await env.DB.prepare(`SELECT id, source, source_ref FROM tenders WHERE ${where}`)
      .bind(...part.flatMap((t) => [t.source, t.source_ref]))
      .all<{ id: string; source: string; source_ref: string }>();
    for (const r of res.results) existing.set(`${r.source}|${r.source_ref}`, r.id);
  }
  const stmt = env.DB.prepare(UPSERT);
  const result: { id: string; isNew: boolean }[] = [];
  const batch: D1PreparedStatement[] = [];
  for (const t of tenders) {
    const id = existing.get(`${t.source}|${t.source_ref}`);
    result.push({ id: id ?? t.id, isNew: !id });
    batch.push(stmt.bind(t.id, t.source, t.source_ref, t.title, t.buyer, t.buyer_key, t.country, JSON.stringify(t.cpv), t.value_eur, t.deadline, t.url, JSON.stringify(t.lots), t.published_at, t.raw ? JSON.stringify(t.raw) : null));
  }
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  return result;
}

/** Per-day counters other code can read (`limits_counters`): keys `scan:<metric>`. */
export async function bumpCounters(env: Env, day: string, counts: Record<string, number>): Promise<void> {
  const stmt = env.DB.prepare('INSERT INTO limits_counters (key, day, count) VALUES (?, ?, ?) ON CONFLICT(key, day) DO UPDATE SET count = count + excluded.count');
  const entries = Object.entries(counts);
  if (entries.length) await env.DB.batch(entries.map(([k, n]) => stmt.bind(`scan:${k}`, day, n)));
}

/** One `runs` row per workspace scan plus a run_step per model call. */
export async function recordScanRun(env: Env, workspaceId: string, day: string, startedAt: string, steps: StepRecord[], failed: boolean): Promise<string> {
  const runId = newId('run');
  const now = new Date().toISOString();
  const tin = steps.reduce((a, s) => a + s.tokensIn, 0);
  const tout = steps.reduce((a, s) => a + s.tokensOut, 0);
  const cost = steps.reduce((a, s) => a + s.costUsd, 0);
  await env.DB.prepare(
    `INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at, finished_at, tokens_in, tokens_out, cost_usd, replay)
     VALUES (?, ?, 'scan', ?, 'scan', ?, ?, ?, ?, ?, ?, 0)`,
  ).bind(runId, workspaceId, day, failed ? 'failed' : 'completed', startedAt, now, tin, tout, cost).run();
  const ins = env.DB.prepare(
    `INSERT INTO run_steps (id, run_id, seq, at, purpose, model, status, tokens_in, tokens_out, tokens_cached, ms, cost_usd, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmts = steps.map((s, i) => ins.bind(newId('step'), runId, i + 1, now, s.purpose, s.model, s.status, s.tokensIn, s.tokensOut, s.tokensCached, s.ms, s.costUsd, s.summary ?? null));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return runId;
}
