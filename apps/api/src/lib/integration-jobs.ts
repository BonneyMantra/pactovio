import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { HttpError } from '@pactovio/contracts';
import { Id, Slug, TableInput, conflict, sensitive, RecordInput } from './integration-input';
import { isAdapter, selections, bindingIssue } from './integration-bindings';
import { ownConnection, verifiedAccount } from './integration-connections';
import { canonical } from './integration-schema';
import { randomToken } from './db';
import { readSelected, type SourceRow } from './integration-read';
export const SelectInput = z.object({ connection_id: Id, adapter: Slug, resource: z.record(z.string(), z.unknown()) }).strict();
export interface ImportJob {
  id: string; workspace_id: string; connection_id: string | null; account_id: string | null; toolkit: string; adapter: string;
  resource_json: string; state: string; revision: number; cursor_json: string; exhausted: number;
  read_token: string | null; lease_until: number | null; preview_json: string | null; preview_hash: string | null;
  approval_key: string | null; error_code: string | null; created_at: string; updated_at: string;
}
export async function ownJob(env: Env, workspace: string, id: string) {
  const job = await env.DB.prepare('SELECT * FROM integration_jobs WHERE workspace_id=? AND id=?').bind(workspace, Id.parse(id)).first<ImportJob>();
  if (!job) throw new HttpError(404, 'Import not found', 'not_found');
  return job;
}
export async function jobStatus(env: Env, workspace: string, id: string) {
  const job = await ownJob(env, workspace, id);
  const counts = await env.DB.prepare('SELECT COUNT(*) AS staged, COALESCE(SUM(applied),0) AS applied FROM integration_staging WHERE job_id=?').bind(id)
    .first<{ staged: number; applied: number }>();
  return { id: job.id, connection_id: job.connection_id, toolkit: job.toolkit, adapter: job.adapter,
    resource: JSON.parse(job.resource_json), state: job.state, revision: job.revision, exhausted: !!job.exhausted,
    staged: counts!.staged, applied: counts!.applied, error_code: job.error_code,
    preview_hash: job.preview_hash, preview: job.preview_json ? JSON.parse(job.preview_json) : null,
    retry_after: job.read_token ? Math.max(0, Math.ceil(((job.lease_until ?? 0) - Date.now()) / 1000)) : 0,
    created_at: job.created_at, updated_at: job.updated_at };
}
export async function selectedJob(env: Env, workspace: string, input: z.infer<typeof SelectInput>) {
  if (!isAdapter(input.adapter)) throw new HttpError(409, 'This toolkit currently supports discovery only.', 'discovery_only');
  if (bindingIssue(input.adapter)) throw new HttpError(409, 'This source input schema needs compatibility verification.', 'adapter_changed');
  const resource = selections[input.adapter].parse(input.resource);
  const connection = await ownConnection(env, workspace, input.connection_id);
  if (connection.toolkit !== input.adapter) throw new HttpError(400, 'The selected connection does not match this source.', 'validation');
  await verifiedAccount(env, connection);
  const id = `imp_${randomToken(16)}`, at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO integration_jobs(id,workspace_id,connection_id,account_id,toolkit,adapter,resource_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, workspace, connection.id, connection.account_id, connection.toolkit, input.adapter, canonical(resource), at, at).run();
  return jobStatus(env, workspace, id);
}
function stageStatement(env: Env, job: string, records: SourceRow[], at: string) {
  return env.DB.prepare(`INSERT INTO integration_staging(job_id,external_id,source_version,retrieved_at,record_json)
    SELECT ?,json_extract(value,'$.external_id'),json_extract(value,'$.source_version'),?,json_extract(value,'$.record')
    FROM json_each(?) WHERE 1 ON CONFLICT(job_id,external_id) DO NOTHING`).bind(job, at, JSON.stringify(records));
}
export async function tabularJob(env: Env, workspace: string, input: z.infer<typeof TableInput>) {
  const id = `imp_${randomToken(16)}`, at = new Date().toISOString(), seen = new Set<string>();
  const records = input.rows.map(record => {
    if (Object.keys(record).some(k => sensitive.test(k) || ['__proto__', 'constructor', 'prototype', '_source_id'].includes(k))) throw new HttpError(400, 'Remove credential fields and reserved columns before staging.', 'validation');
    const value = record[input.external_id_field];
    const external_id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!external_id || external_id.length > 200 || seen.has(external_id)) throw new HttpError(400, 'Every row needs a unique, nonempty external ID.', 'validation');
    seen.add(external_id);
    return { external_id, source_version: null, record: { ...RecordInput.parse(record), _source_id: external_id } };
  });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO integration_jobs(id,workspace_id,toolkit,adapter,resource_json,state,exhausted,created_at,updated_at)
      VALUES(?,?,'tabular','tabular',?,'staged',1,?,?)`).bind(id, workspace, canonical({ resource: input.resource }), at, at),
    stageStatement(env, id, records, at),
  ]);
  return jobStatus(env, workspace, id);
}
export async function readJob(env: Env, workspace: string, id: string, revision: number, session: string) {
  const job = await ownJob(env, workspace, id);
  if (job.revision !== revision || job.exhausted || !isAdapter(job.adapter) || !job.connection_id) conflict();
  const connection = await ownConnection(env, workspace, job.connection_id);
  if (connection.account_id !== job.account_id) throw new HttpError(409, 'The source account changed. Start a new import.', 'connection_changed');
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM integration_staging WHERE job_id=? AND applied=0').bind(id).first<{ n: number }>();
  if (total!.n >= 500) throw new HttpError(409, 'Review and approve the pending records before reading the next page.', 'selection_limit');
  const token = randomToken(16), now = Date.now();
  const lease = await env.DB.prepare(`UPDATE integration_jobs SET read_token=?,lease_until=?,state='reading',error_code=NULL
    WHERE id=? AND workspace_id=? AND revision=? AND (read_token IS NULL OR lease_until<=?)`)
    .bind(token, now + 60000, id, workspace, revision, now).run();
  if (!lease.meta.changes) conflict();
  try {
    const page = await readSelected(env, connection, job.adapter, JSON.parse(job.resource_json), JSON.parse(job.cursor_json));
    if (total!.n + page.rows.length > 500) throw new HttpError(409, 'Narrow this source selection to at most 500 records.', 'selection_limit');
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO integration_transaction_guard(token,valid) SELECT ?,CASE WHEN EXISTS(
        SELECT 1 FROM integration_jobs j JOIN integration_connections c ON c.id=j.connection_id
        WHERE j.id=? AND j.workspace_id=? AND j.read_token=? AND j.revision=? AND c.status='active' AND c.account_id=j.account_id
        AND EXISTS(SELECT 1 FROM customer_sessions s JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id
          WHERE s.id=? AND s.workspace_id=j.workspace_id AND s.revoked_at IS NULL AND s.expires_at>?)) THEN 1 ELSE 0 END`)
        .bind(token, id, workspace, token, revision, session, Date.now()),
      stageStatement(env, id, page.rows, at),
      env.DB.prepare(`UPDATE integration_jobs SET cursor_json=?,exhausted=?,read_token=NULL,lease_until=NULL,state='staged',revision=revision+1,
        preview_json=NULL,preview_hash=NULL,updated_at=? WHERE id=? AND read_token=?`)
        .bind(JSON.stringify(page.next), page.exhausted ? 1 : 0, at, id, token),
      env.DB.prepare('DELETE FROM integration_transaction_guard WHERE token=?').bind(token),
    ]);
  } catch (error) {
    const code = error instanceof HttpError ? error.code ?? 'source_read_failed' : 'source_read_failed';
    await env.DB.prepare(`UPDATE integration_jobs SET state='read_failed',error_code=?,read_token=NULL,lease_until=NULL,revision=revision+1,updated_at=?
      WHERE id=? AND workspace_id=? AND read_token=?`).bind(code, new Date().toISOString(), id, workspace, token).run();
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'This source read could not finish. Resume to retry the last checkpoint.', 'source_read_failed');
  }
  return jobStatus(env, workspace, id);
}
export async function stagedRows(env: Env, workspace: string, id: string, offset: number, pending = false) {
  await ownJob(env, workspace, id);
  const result = await env.DB.prepare(`SELECT external_id,source_version,retrieved_at,record_json,applied FROM integration_staging
    WHERE job_id=? ${pending ? 'AND applied=0' : ''} ORDER BY external_id LIMIT 50 OFFSET ?`).bind(id, offset).all<{ external_id: string; source_version: string | null; retrieved_at: string; record_json: string; applied: number }>();
  return { items: result.results.map(r => ({ external_id: r.external_id, source_version: r.source_version, retrieved_at: r.retrieved_at, record: JSON.parse(r.record_json), applied: !!r.applied })),
    offset, next_offset: result.results.length === 50 ? offset + 50 : null };
}
