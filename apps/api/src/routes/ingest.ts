import type { Context } from 'hono';
import { endpoints, HttpError } from '@pactovio/contracts';
import { emit } from '@pactovio/events';
import { one, rows, exec, nowIso } from '../lib/db';
import { errorResponse, type Register } from '../lib/router';
import type { AppEnv } from '../lib/types';

/** Constant-time compare that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

function requireSecret(c: Context<AppEnv>): void {
  const secret = c.env.INGEST_SECRET;
  const given = c.req.header('x-ingest-secret') ?? '';
  if (!secret || !safeEqual(given, secret)) throw new HttpError(401, 'Invalid ingest secret', 'unauthorized');
}

interface AuditRow { id: string; workspace_id: string; subject_type: string; subject_id: string; created_at: string }
interface AnswerRow { id: string; question_ref: string; question: string; draft: string; claims: { text: string; evidence_ids: string[]; supported: boolean }[] }
interface ChunkRow { evidence_id: string; title: string | null; seq: number; text: string }

const MAX_CHUNKS_PER_ANSWER = 12;
const MAX_CHUNK_CHARS = 1500;

async function evidenceFor(db: D1Database, workspaceId: string, ids: string[]) {
  const out: { evidence_id: string; title: string; chunk_id: string; text: string }[] = [];
  const pool = ids.length ? ids : (await rows<{ id: string }>(db, 'SELECT id FROM evidence WHERE workspace_id = ? ORDER BY id LIMIT 8', workspaceId)).map((r) => r.id);
  for (const evId of pool) {
    const chunks = await rows<ChunkRow>(db,
      'SELECT c.evidence_id, e.title, c.seq, c.text FROM evidence_chunks c JOIN evidence e ON e.id = c.evidence_id WHERE c.workspace_id = ? AND c.evidence_id = ? ORDER BY c.seq LIMIT 6', workspaceId, evId);
    if (chunks.length) {
      for (const ch of chunks) out.push({ evidence_id: ch.evidence_id, title: ch.title ?? ch.evidence_id, chunk_id: `${ch.evidence_id}#${ch.seq}`, text: ch.text.slice(0, MAX_CHUNK_CHARS) });
      continue;
    }
    // No chunks stored yet (pack lane may not have indexed): fall back to the evidence text itself.
    const ev = await one<{ id: string; title: string; text: string | null }>(db, 'SELECT id, title, text FROM evidence WHERE id = ? AND workspace_id = ?', evId, workspaceId);
    if (ev?.text) out.push({ evidence_id: ev.id, title: ev.title, chunk_id: `${ev.id}#0`, text: ev.text.slice(0, MAX_CHUNK_CHARS) });
  }
  return out.slice(0, MAX_CHUNKS_PER_ANSWER);
}

async function buildQueueItem(db: D1Database, a: AuditRow) {
  const where = a.subject_type === 'answer' ? 'id = ?' : 'tender_id = ?';
  const answers = await rows<AnswerRow>(db, `SELECT id, question_ref, question, draft, claims_json FROM answers WHERE workspace_id = ? AND ${where} ORDER BY question_ref`, a.workspace_id, a.subject_id);
  const items = [];
  for (const ans of answers) {
    const ids = [...new Set(ans.claims.flatMap((cl) => cl.evidence_ids))];
    items.push({ answer_id: ans.id, question_ref: ans.question_ref, question: ans.question, draft: ans.draft, claims: ans.claims, evidence: await evidenceFor(db, a.workspace_id, ids) });
  }
  return { audit_id: a.id, workspace_id: a.workspace_id, subject_type: a.subject_type, subject_id: a.subject_id, answers: items };
}

export const register: Register = (r) => {
  // Queue for the Nebius audit job. `claim=1&job_id=...` flips returned audits to running.
  r.app.get('/ingest/audit/queue', async (c) => {
    try {
      requireSecret(c);
      const queued = await rows<AuditRow>(c.env.DB, "SELECT id, workspace_id, subject_type, subject_id, created_at FROM audits WHERE status = 'queued' ORDER BY created_at LIMIT 5");
      const items = [];
      for (const a of queued) items.push(await buildQueueItem(c.env.DB, a));
      if (c.req.query('claim') === '1') {
        const jobId = (c.req.query('job_id') ?? '').slice(0, 120) || null;
        for (const a of queued) await exec(c.env.DB, "UPDATE audits SET status = 'running', job_id = COALESCE(?, job_id) WHERE id = ? AND status = 'queued'", jobId, a.id);
      }
      return c.json({ items });
    } catch (e) { return errorResponse(c, e); }
  });

  // Public (no session): the Nebius audit job authenticates with the shared secret header.
  r.on(endpoints.ingestAudit, async ({ c, env, db, body }) => {
    requireSecret(c);
    const audit = await one<{ id: string; workspace_id: string; subject_type: string; subject_id: string; job_id: string | null }>(db, 'SELECT id, workspace_id, subject_type, subject_id, job_id FROM audits WHERE id = ?', body.audit_id);
    if (!audit) throw new HttpError(404, 'Unknown audit', 'not_found');
    const result = body.result ?? null;
    await exec(db, 'UPDATE audits SET status = ?, result_json = ?, job_id = COALESCE(?, job_id), completed_at = ? WHERE id = ?',
      body.status, result === null ? null : JSON.stringify(result), body.job_id ?? null, nowIso(), audit.id);
    // Red-team table is global, not per-audit: kept in KV for GET /limits.
    const rt = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).red_team : undefined;
    if (rt) await env.CACHE.put('audit:red_team:latest', JSON.stringify({ at: nowIso(), job_id: body.job_id ?? audit.job_id, red_team: rt }));
    const summary = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).summary : undefined;
    await emit(env, audit.workspace_id, 'audit.completed', { audit_id: audit.id, subject_type: audit.subject_type, subject_id: audit.subject_id, status: body.status, summary: summary ?? null });
    return c.json({ ok: true });
  });

  r.on(endpoints.getAudit, async ({ db, params, workspaceId }) => {
    const a = await one<Record<string, unknown>>(db, 'SELECT * FROM audits WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!a) throw new HttpError(404, 'Audit not found', 'not_found');
    return a as never;
  });
};
