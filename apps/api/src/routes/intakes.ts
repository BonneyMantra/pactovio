import { endpoints, HttpError, newId, type Document, type Intake, type IntakeSource } from '@pactovio/contracts';
import { docKind, storeMessage, type IntakeJob } from '@pactovio/connectors';
import { emit } from '@pactovio/events';
import { apiKeyAuth, sessionAuth } from '../lib/auth';
import { exec, nowIso, one, rows } from '../lib/db';
import type { Register } from '../lib/router';
import type { Env } from '@pactovio/contracts/env';

const DOORS = ['tender', 'rfp', 'design'] as const;
type Door = (typeof DOORS)[number];
const MAX_FILE = 15 * 1024 * 1024;

interface NewIntake {
  title?: string; sender?: string; text?: string; door?: Door; files: { filename: string; mimetype: string; bytes: Uint8Array }[];
}

/** Shared by the JSON paste and the multipart upload: store the message, open the intake, start IntakeWorkflow. */
async function createIntake(env: Env, workspaceId: string, via: string, n: NewIntake): Promise<{ intake_id: string; status: string }> {
  const text = n.text?.trim() ?? '';
  if (!text && !n.files.length) throw new HttpError(400, 'Send some text or at least one file', 'validation');
  if (n.files.some((f) => !docKind(f.filename))) throw new HttpError(400, 'Supported files: PDF, DOCX, XLSX, CSV, images and ZIP', 'validation');
  const id = newId('intake');
  const source: IntakeSource = via === 'apikey' ? 'api' : 'upload';
  const title = (n.title?.trim() || text.split('\n')[0]?.slice(0, 120) || n.files[0]?.filename || 'Untitled intake').slice(0, 200);
  const job: IntakeJob = { intakeId: id, workspaceId, source, forceDoor: n.door };
  await exec(env.DB, "INSERT INTO intakes (id, workspace_id, door, source, title, sender, received_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'new')", id, workspaceId, n.door ?? 'rfp', source, title, n.sender?.trim() || null, nowIso());
  job.prestored = await storeMessage(env, job, { from: n.sender?.trim() || 'upload', subject: title, body: text, receivedAt: nowIso() }, n.files);
  try {
    await env.INTAKE.create({ id, params: job });
  } catch (e) {
    await exec(env.DB, "UPDATE intakes SET status = 'ignored' WHERE id = ?", id);
    throw new HttpError(502, `Could not start the intake workflow: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`, 'upstream');
  }
  await emit(env, workspaceId, 'intake.received', { intake_id: id, source, title, sender: n.sender ?? null });
  return { intake_id: id, status: 'new' };
}

export const register: Register = (r) => {
  r.on(endpoints.listIntakes, async ({ db, workspaceId, query }) => {
    const where = ['workspace_id = ?'];
    const b: unknown[] = [workspaceId];
    if (query.door) { where.push('door = ?'); b.push(query.door); }
    if (query.status) { where.push('status = ?'); b.push(query.status); }
    return { items: await rows<Intake>(db, `SELECT * FROM intakes WHERE ${where.join(' AND ')} ORDER BY received_at DESC LIMIT ?`, ...b, query.limit ?? 50) };
  });
  r.on(endpoints.getIntake, async ({ db, workspaceId, params }) => {
    const intake = await one<Intake>(db, 'SELECT * FROM intakes WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!intake) throw new HttpError(404, 'Intake not found', 'not_found');
    return { intake, documents: await rows<Document>(db, 'SELECT * FROM documents WHERE intake_id = ?', intake.id) };
  });

  // Pasted text (JSON). Files go to POST /intakes/upload.
  r.on(endpoints.createIntake, async ({ env, auth, workspaceId, body }) => createIntake(env, workspaceId, auth.via, { ...body, files: [] }));

  // multipart: file (one or more), title?, sender?, text?, door? -> same pipeline as an emailed RFP.
  r.app.post('/intakes/upload', async (c) => {
    try {
      const auth = r.mode === 'session' ? await sessionAuth(c) : await apiKeyAuth(c);
      const form = await c.req.formData().catch(() => null);
      if (!form) throw new HttpError(400, 'Send multipart form data', 'validation');
      const files: NewIntake['files'] = [];
      for (const f of form.getAll('file')) {
        if (!(f instanceof File)) continue;
        if (f.size > MAX_FILE) throw new HttpError(400, `${f.name} is larger than 15 MB`, 'validation');
        files.push({ filename: f.name || 'upload', mimetype: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) });
      }
      const s = (k: string) => { const v = form.get(k); return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
      const door = s('door');
      if (door && !DOORS.includes(door as Door)) throw new HttpError(400, 'door must be tender, rfp or design', 'validation');
      return c.json(await createIntake(c.env, auth.workspaceId, auth.via, { title: s('title'), sender: s('sender'), text: s('text'), door: door as Door | undefined, files }));
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: e.message, code: e.code ?? 'error' }, e.status);
      throw e;
    }
  });
};
