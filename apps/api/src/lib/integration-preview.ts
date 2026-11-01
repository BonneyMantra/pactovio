import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { HttpError, newId, ProductInput } from '@pactovio/contracts';
import { PreviewInput, mapProduct, conflict } from './integration-input';
import { canonical, fingerprint } from './integration-schema';
import { ownJob, jobStatus, type ImportJob } from './integration-jobs';
export const PreviewRow = z.object({ external_id: z.string(), source_version: z.string().nullable(), retrieved_at: z.string(),
  product: ProductInput.nullable(), unresolved: z.array(z.string()), target_id: z.string(), expected_revision: z.number().int().nullable(),
  resolution: ProductInput.partial(),
});
export const FrozenPreview = z.object({ revision: z.number().int(), source_key: z.string(), mapping: PreviewInput.shape.mapping,
  rows: z.array(PreviewRow).min(1).max(100), write_scope: z.literal('pactovio_catalogue_only') });
export type Frozen = z.infer<typeof FrozenPreview>;
export async function sourceKey(job: ImportJob) {
  return fingerprint({ toolkit: job.toolkit, account_id: job.account_id, resource: JSON.parse(job.resource_json) });
}
export async function freezePreview(env: Env, workspace: string, id: string, input: z.infer<typeof PreviewInput>) {
  const job = await ownJob(env, workspace, id);
  if (job.revision !== input.revision || job.read_token) conflict();
  const source_key = await sourceKey(job), rows: z.infer<typeof PreviewRow>[] = [];
  if (new Set(input.resolutions.map(r => r.external_id)).size !== input.resolutions.length || input.resolutions.some(r => !input.selected_ids.includes(r.external_id))) {
    throw new HttpError(400, 'Resolutions must identify unique selected rows.', 'validation');
  }
  const staged = await env.DB.prepare(`SELECT s.*,b.product_id,b.product_revision,v.revision AS target_revision,p.id AS existing_id
    FROM integration_staging s LEFT JOIN integration_provenance b ON b.workspace_id=? AND b.source_key=? AND b.external_id=s.external_id
    LEFT JOIN products p ON p.id=b.product_id AND p.workspace_id=b.workspace_id
    LEFT JOIN integration_product_versions v ON v.product_id=b.product_id
    WHERE s.job_id=? AND s.external_id IN (SELECT value FROM json_each(?))`)
    .bind(workspace, source_key, id, JSON.stringify(input.selected_ids)).all<{
      external_id: string; record_json: string; source_version: string | null; retrieved_at: string; applied: number;
      product_id: string | null; product_revision: number | null; target_revision: number | null; existing_id: string | null;
    }>();
  for (const external_id of input.selected_ids) {
    const row = staged.results.find(r => r.external_id === external_id);
    if (!row || row.applied) throw new HttpError(409, 'Select unapplied records from this import.', 'selection_conflict');
    const record = JSON.parse(row.record_json), resolution = input.resolutions.find(r => r.external_id === external_id)?.product ?? {};
    const mapped = mapProduct(record, input.mapping, resolution);
    if (String(record[input.mapping.external_id] ?? '') !== external_id) mapped.unresolved.push('external_id');
    if (row.product_id && (!row.existing_id || row.target_revision !== row.product_revision)) mapped.unresolved.push('manual_edit_conflict');
    rows.push({ external_id, source_version: row.source_version, retrieved_at: row.retrieved_at, ...mapped,
      target_id: row.product_id ?? newId('product'), expected_revision: row.target_revision, resolution });
  }
  const existingSkus = await env.DB.prepare(`SELECT id,UPPER(sku) AS sku FROM products WHERE workspace_id=?
    AND UPPER(sku) IN (SELECT value FROM json_each(?))`).bind(workspace, JSON.stringify(rows.map(r => r.product?.sku).filter(Boolean))).all<{ id: string; sku: string }>();
  for (const row of rows) if (row.product && existingSkus.results.some(p => p.sku === row.product!.sku && p.id !== row.target_id)) row.unresolved.push('duplicate_sku');
  for (const row of rows) {
    if (row.product && rows.filter(r => r.product?.sku === row.product!.sku).length > 1) row.unresolved.push('duplicate_sku');
  }
  const preview = FrozenPreview.parse({ revision: job.revision + 1, source_key, mapping: input.mapping, rows, write_scope: 'pactovio_catalogue_only' });
  const hash = await fingerprint(preview), at = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE integration_jobs SET preview_json=?,preview_hash=?,revision=revision+1,state='preview',error_code=NULL,updated_at=?
    WHERE id=? AND workspace_id=? AND revision=? AND read_token IS NULL`).bind(canonical(preview), hash, at, id, workspace, job.revision).run();
  if (!updated.meta.changes) conflict();
  return jobStatus(env, workspace, id);
}
