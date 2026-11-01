import { api } from './ui.js';

export const EVIDENCE_KINDS = ['datasheet', 'certificate', 'insurance', 'case_study', 'other'];
export const EVIDENCE_ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg,.webp,.txt';
export const EVIDENCE_MAX_BYTES = 12 * 1024 * 1024;

export function validateEvidence(files, { title = '', kind = '', validTo = '' } = {}) {
  if (!files || files.length !== 1 || !(files[0] instanceof File)) return 'Choose exactly one file to upload.';
  const file = files[0];
  if (!file.size) return 'This file is empty. Choose a document with content.';
  if (file.size > EVIDENCE_MAX_BYTES) return 'Choose a file no larger than 12 MB.';
  if (!/\.(pdf|docx|png|jpe?g|webp|txt)$/i.test(file.name)) return 'Choose a PDF, DOCX, PNG, JPG, WebP or TXT file.';
  if (!EVIDENCE_KINDS.includes(kind)) return 'Choose the type of evidence you are uploading.';
  if (title.trim().length > 200) return 'Keep the evidence title within 200 characters.';
  if (validTo) {
    const date = new Date(`${validTo}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validTo) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== validTo) return 'Enter a real expiry date as YYYY-MM-DD, or leave it blank.';
  }
  return null;
}

export async function uploadEvidence(files, details, signal) {
  const invalid = validateEvidence(files, details);
  if (invalid) throw Object.assign(new Error(invalid), { code: 'validation', status: 400 });
  const body = new FormData(); body.append('file', files[0]);
  body.append('kind', details.kind);
  if (details.title?.trim()) body.append('title', details.title.trim());
  if (details.validTo) body.append('valid_to', details.validTo);
  const result = await api('/evidence', { method: 'POST', body, signal: signal || AbortSignal.timeout(180000) });
  if (typeof result?.evidence_id !== 'string' || !result.evidence_id || result.status !== 'ready') throw new Error('Upload acceptance could not be confirmed');
  return result;
}

export function uploadError(error) {
  if (error.code === 'cap_daily') return 'Document reading has reached its daily budget. Your file is still selected; try again when the budget resets.';
  if (error.code === 'models_off') return 'Document reading is temporarily paused. Your file is still selected; try again when the service resumes.';
  if (error.status === 429) return 'Too many upload requests. Wait a moment, then try again with the selected file.';
  if (error.status === 401) return 'Your session expired. Sign in again, then select your file to continue.';
  if (error.status === 400 || error.status === 413 || error.code === 'validation') return error.message;
  if (error.status >= 500) return 'The document-reading service could not finish. Refresh the evidence list to check whether your file was saved before retrying.';
  return 'We could not confirm the upload. Check your connection and refresh the evidence list before retrying; your file is still selected.';
}
