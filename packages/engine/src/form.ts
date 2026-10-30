import { fromRow, HttpError, type Answer, type Document, type ReqStatus } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { fillDocx, type FormEntry } from './docx-fill';

export const filledKey = (workspaceId: string, tenderId: string, docId: string) => `filled/${workspaceId}/${tenderId}/${docId}.docx`;

const COMPLIANCE: Partial<Record<ReqStatus, FormEntry['compliance']>> = { MET: 'Yes', PARTIAL: 'Partial', GAP: 'No' };
const lotOf = (filename: string) => /lot[\s_-]*(\d)/i.exec(filename)?.[1] ?? null;

/**
 * Write approved answers into the buyer's own DOCX response form (rows matched by reference number), keep every other
 * part of the file byte-identical, store the result in R2 and return its key. The Yes/No/Partial list is set from the
 * matrix status of that requirement only where the form offers the option.
 */
export async function fillFormImpl(env: Env, docId: string, answers: Answer[]): Promise<string> {
  const row = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(docId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, 'Document not found', 'not_found');
  const doc = fromRow<Document>(row);
  if (doc.kind !== 'docx' || !doc.tender_id) throw new HttpError(400, 'Only DOCX response forms can be filled', 'validation');
  const src = await env.FILES.get(doc.r2_key);
  if (!src) throw new HttpError(404, 'The original form file is not in storage', 'not_found');
  const lot = lotOf(doc.filename);
  const mine = answers.filter((a) => a.tender_id === doc.tender_id && (!lot || !a.lot || a.lot === lot));
  if (!mine.length) throw new HttpError(400, 'No answers for this form', 'validation');
  const ws = mine[0]!.workspace_id;
  const status = new Map<string, ReqStatus>();
  const rq = await env.DB.prepare('SELECT ref, lot, status FROM requirements WHERE workspace_id = ? AND tender_id = ?').bind(ws, doc.tender_id).all<{ ref: string; lot: string | null; status: ReqStatus }>();
  for (const r of rq.results) if (!lot || !r.lot || r.lot === lot) status.set(r.ref.toLowerCase(), r.status);
  const entries: FormEntry[] = mine.map((a) => ({ ref: a.question_ref, response: a.draft, compliance: COMPLIANCE[status.get(a.question_ref.toLowerCase()) as ReqStatus] }));
  const { bytes } = fillDocx(new Uint8Array(await src.arrayBuffer()), entries);
  const key = filledKey(ws, doc.tender_id, docId);
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, customMetadata: { filename: doc.filename } });
  return key;
}
