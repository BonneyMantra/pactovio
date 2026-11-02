import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { HttpError } from '@pactovio/contracts';
import { ApproveInput, conflict } from './integration-input';
import { ownJob, type ImportJob } from './integration-jobs';
import { FrozenPreview, type Frozen } from './integration-preview';
import { fingerprint, canonical } from './integration-schema';
import { randomToken } from './db';
import { ownConnection, verifiedAccount } from './integration-connections';
function guard(env: Env, token: string, sql: string, args: unknown[]) {
  return env.DB.prepare(`INSERT INTO integration_transaction_guard(token,valid) SELECT ?, CASE WHEN ${sql} THEN 1 ELSE 0 END`).bind(token, ...args);
}
/** Each source/target precondition and every catalogue/provenance write shares one transactional D1 batch. */
function rowWrites(env: Env, job: ImportJob, preview: Frozen, token: string) {
  const rows = canonical(preview.rows), rowToken = `${token}_rows`;
  // Set operations keep a 100-row approval inside the D1 query budget, including on free plans.
  return [
    guard(env, rowToken, `NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE
      NOT EXISTS(SELECT 1 FROM integration_staging s WHERE s.job_id=? AND s.external_id=json_extract(r.value,'$.external_id') AND s.applied=0)
      OR EXISTS(SELECT 1 FROM products p WHERE p.workspace_id=? AND UPPER(p.sku)=json_extract(r.value,'$.product.sku') AND p.id!=json_extract(r.value,'$.target_id'))
      OR CASE WHEN json_extract(r.value,'$.expected_revision') IS NULL THEN
        EXISTS(SELECT 1 FROM products p WHERE p.id=json_extract(r.value,'$.target_id')) OR
        EXISTS(SELECT 1 FROM integration_provenance b WHERE b.workspace_id=? AND b.source_key=? AND b.external_id=json_extract(r.value,'$.external_id'))
      ELSE NOT EXISTS(SELECT 1 FROM products p JOIN integration_product_versions v ON v.product_id=p.id
        JOIN integration_provenance b ON b.product_id=p.id AND b.workspace_id=p.workspace_id
        WHERE p.id=json_extract(r.value,'$.target_id') AND p.workspace_id=? AND v.revision=json_extract(r.value,'$.expected_revision')
        AND b.product_revision=v.revision AND b.source_key=? AND b.external_id=json_extract(r.value,'$.external_id')) END)`,
    [rows, job.id, job.workspace_id, job.workspace_id, preview.source_key, job.workspace_id, preview.source_key]),
    env.DB.prepare(`INSERT INTO products(id,workspace_id,sku,name,family,specs_json,unit_price_minor,currency)
      SELECT json_extract(r.value,'$.target_id'),?,json_extract(r.value,'$.product.sku'),json_extract(r.value,'$.product.name'),
        json_extract(r.value,'$.product.family'),json_object('unit',json_extract(r.value,'$.product.unit'),'price_basis','Approved source import'),
        json_extract(r.value,'$.product.unit_price_minor'),json_extract(r.value,'$.product.currency') FROM json_each(?) r
      WHERE json_extract(r.value,'$.expected_revision') IS NULL`).bind(job.workspace_id, rows),
    env.DB.prepare(`UPDATE products SET (sku,name,family,specs_json,unit_price_minor,currency)=(
      SELECT json_extract(r.value,'$.product.sku'),json_extract(r.value,'$.product.name'),json_extract(r.value,'$.product.family'),
        json_patch(products.specs_json,json_object('unit',json_extract(r.value,'$.product.unit'),'price_basis','Approved source import')),
        json_extract(r.value,'$.product.unit_price_minor'),json_extract(r.value,'$.product.currency') FROM json_each(?) r
        WHERE json_extract(r.value,'$.target_id')=products.id)
      WHERE workspace_id=? AND id IN (SELECT json_extract(value,'$.target_id') FROM json_each(?) WHERE json_extract(value,'$.expected_revision') IS NOT NULL)`)
      .bind(rows, job.workspace_id, rows),
    env.DB.prepare(`INSERT INTO integration_provenance(workspace_id,source_key,external_id,toolkit,account_id,resource_json,source_version,
      retrieved_at,product_id,product_revision,resolution_json,preview_hash,job_id)
      SELECT ?,?,json_extract(r.value,'$.external_id'),?,?,?,json_extract(r.value,'$.source_version'),json_extract(r.value,'$.retrieved_at'),
        json_extract(r.value,'$.target_id'),v.revision,json_extract(r.value,'$.resolution'),?,? FROM json_each(?) r
        JOIN integration_product_versions v ON v.product_id=json_extract(r.value,'$.target_id') WHERE 1
      ON CONFLICT(workspace_id,source_key,external_id) DO UPDATE SET source_version=excluded.source_version,retrieved_at=excluded.retrieved_at,
        product_revision=excluded.product_revision,resolution_json=excluded.resolution_json,preview_hash=excluded.preview_hash,job_id=excluded.job_id`)
      .bind(job.workspace_id, preview.source_key, job.toolkit, job.account_id, job.resource_json, job.preview_hash, job.id, rows),
    env.DB.prepare(`UPDATE integration_staging SET applied=1 WHERE job_id=? AND external_id IN (SELECT json_extract(value,'$.external_id') FROM json_each(?))`).bind(job.id, rows),
    env.DB.prepare('DELETE FROM integration_transaction_guard WHERE token=?').bind(rowToken),
  ];
}
export async function approvePreview(env: Env, workspace: string, id: string, input: z.infer<typeof ApproveInput>, session: string) {
  const job = await ownJob(env, workspace, id);
  const receipt = await env.DB.prepare('SELECT * FROM integration_approval_receipts WHERE job_id=? AND idempotency_key=?')
    .bind(id, input.idempotency_key).first<{ preview_hash: string; revision: number; result_json: string }>();
  if (receipt) {
    if (receipt.preview_hash !== input.preview_hash || receipt.revision !== input.revision) conflict();
    return JSON.parse(receipt.result_json);
  }
  if (job.revision !== input.revision || job.state !== 'preview' || job.preview_hash !== input.preview_hash || !job.preview_json || job.read_token) conflict();
  const preview = FrozenPreview.parse(JSON.parse(job.preview_json));
  if (preview.revision !== job.revision || await fingerprint(preview) !== input.preview_hash) conflict();
  if (preview.rows.some(r => !r.product || r.unresolved.length)) throw new HttpError(409, 'Resolve every selected record before approving this preview.', 'unresolved_fields');
  if (job.connection_id) {
    const connection = await ownConnection(env, workspace, job.connection_id);
    if (connection.account_id !== job.account_id) conflict();
    await verifiedAccount(env, connection);
  }
  const token = randomToken(16), at = new Date().toISOString();
  const result = { id, approval_key: input.idempotency_key, preview_hash: input.preview_hash, applied: preview.rows.length, revision: job.revision + 1 };
  try {
    await env.DB.batch([
      guard(env, token, `EXISTS(SELECT 1 FROM integration_jobs j WHERE j.id=? AND j.workspace_id=? AND j.state='preview'
        AND j.revision=? AND j.preview_hash=? AND j.read_token IS NULL
        AND EXISTS(SELECT 1 FROM customer_sessions s JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id
          WHERE s.id=? AND s.workspace_id=j.workspace_id AND s.revoked_at IS NULL AND s.expires_at>?) AND (j.connection_id IS NULL OR EXISTS(
          SELECT 1 FROM integration_connections c WHERE c.id=j.connection_id AND c.workspace_id=j.workspace_id AND c.status='active' AND c.account_id=j.account_id)))`,
      [id, workspace, input.revision, input.preview_hash, session, Date.now()]),
      ...rowWrites(env, job, preview, token),
      env.DB.prepare(`UPDATE integration_jobs SET state=CASE WHEN exhausted=1 AND NOT EXISTS(
        SELECT 1 FROM integration_staging WHERE job_id=? AND applied=0) THEN 'completed' ELSE 'partial' END,
        revision=revision+1,approval_key=?,error_code=NULL,updated_at=? WHERE id=? AND workspace_id=?`)
        .bind(id, input.idempotency_key, at, id, workspace),
      env.DB.prepare('INSERT INTO integration_approval_receipts(job_id,idempotency_key,preview_hash,revision,result_json,frozen_preview_json) VALUES(?,?,?,?,?,?)')
        .bind(id, input.idempotency_key, input.preview_hash, input.revision, JSON.stringify(result), canonical(preview)),
      env.DB.prepare('DELETE FROM integration_transaction_guard WHERE token=?').bind(token),
    ]);
  } catch {
    // A concurrent identical approval may have won while this request awaited the provider.
    const won = await env.DB.prepare('SELECT result_json,preview_hash,revision FROM integration_approval_receipts WHERE job_id=? AND idempotency_key=?')
      .bind(id, input.idempotency_key).first<{ result_json: string; preview_hash: string; revision: number }>();
    if (won && won.preview_hash === input.preview_hash && won.revision === input.revision) return JSON.parse(won.result_json);
    conflict();
  }
  return result;
}
