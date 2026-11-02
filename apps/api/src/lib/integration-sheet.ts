import { z } from 'zod';
import { HttpError } from '@pactovio/contracts';
import { RecordInput, sensitive } from './integration-input';
import type { SourceRow } from './integration-read';
/** Header/identity selection is explicit and local; it never changes the upstream read operation. */
export function decodeHeaderSheet(values: unknown[][], resource: unknown): SourceRow[] {
  const selection = z.object({ identity_column: z.string().trim().min(1).max(160) }).passthrough().safeParse(resource);
  if (!selection.success) throw new HttpError(400, 'Choose the column containing stable source record IDs.', 'identity_column_required');
  if (!values.length) return [];
  const header = z.array(z.string().trim().min(1).max(160)).max(50).safeParse(values[0]);
  if (!header.success || new Set(header.data).size !== header.data.length || header.data.some(k => sensitive.test(k) || ['__proto__','constructor','prototype','_source_id'].includes(k))) {
    throw new HttpError(400, 'Use unique nonempty headers without credential or reserved columns.', 'source_headers');
  }
  if (!header.data.includes(selection.data.identity_column)) throw new HttpError(400, 'The selected identity column is not in this source header.', 'identity_column_required');
  const seen = new Set<string>();
  return values.slice(1).filter(r => r.some(v => v !== null && v !== '')).map(row => {
    if (!Array.isArray(row) || row.length > header.data.length) throw new HttpError(502, 'Source rows do not match their headers.', 'source_malformed');
    const parsed = RecordInput.safeParse(Object.fromEntries(header.data.map((key,i) => [key,row[i] ?? null])));
    if (!parsed.success) throw new HttpError(502, 'This source contains an unsupported cell value.', 'source_malformed');
    const value = parsed.data[selection.data.identity_column];
    const id = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
    if (!id || id.length > 200 || seen.has(id)) throw new HttpError(400, 'Every source row needs a unique nonempty stable ID.', 'source_identity');
    seen.add(id);
    return { external_id: id, source_version: null, record: { ...parsed.data, _source_id: id } };
  });
}
