import { endpoints, HttpError, type Evidence } from '@pactovio/contracts';
import { ingestEvidenceImpl } from '@pactovio/engine';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

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
    const str = (k: string) => { const v = form.get(k); return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
    return ingestEvidenceImpl(env, { workspaceId, filename: file.name || 'upload', mime: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()), title: str('title'), kind: str('kind'), validTo: str('valid_to') });
  });
};
