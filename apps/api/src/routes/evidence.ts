import { endpoints, HttpError, type Evidence } from '@pactovio/contracts';
import { z } from 'zod';
import { ingestEvidenceImpl } from '@pactovio/engine';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

const UploadDetails = z.object({
  title: z.string().trim().max(200).optional(),
  kind: z.enum(['datasheet', 'certificate', 'insurance', 'case_study', 'other', 'financial', 'policy', 'cv', 'profile', 'capability', 'reference']).optional(),
  valid_to: z.iso.date().optional(),
}).strict();

export const register: Register = (r) => {
  r.on(endpoints.listEvidence, async ({ db, workspaceId, query }) => ({
    items: await rows<Evidence>(db, 'SELECT * FROM evidence WHERE workspace_id = ? ORDER BY kind, title LIMIT ?', workspaceId, query.limit ?? 100),
  }));
  r.on(endpoints.getEvidence, async ({ db, workspaceId, params }) => {
    const e = await one<Evidence>(db, 'SELECT * FROM evidence WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!e) throw new HttpError(404, 'Evidence not found', 'not_found');
    return e;
  });
  // multipart: file, title?, kind?, valid_to?  -> PDF/DOCX text or an image scan, read, chunked and embedded.
  r.on(endpoints.uploadEvidence, async ({ c, env, workspaceId }) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof File)) throw new HttpError(400, 'Send multipart form data with a "file" field', 'validation');
    if ([...form.keys()].some((key) => !['file', 'title', 'kind', 'valid_to'].includes(key) || form.getAll(key).length !== 1)) {
      throw new HttpError(400, 'Send one file with title, kind and valid_to only', 'validation');
    }
    if (!file.size || file.size > 12 * 1024 * 1024 || !/\.(pdf|docx|png|jpe?g|webp|txt)$/i.test(file.name)) {
      throw new HttpError(400, 'Upload one nonempty PDF, DOCX, PNG, JPG, WebP or TXT file up to 12 MB', 'validation');
    }
    const str = (k: string) => { const v = form.get(k); return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
    const details = UploadDetails.parse({ title: str('title'), kind: str('kind'), valid_to: str('valid_to') });
    return ingestEvidenceImpl(env, { workspaceId, filename: file.name, mime: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()), title: details.title, kind: details.kind, validTo: details.valid_to });
  });
};
