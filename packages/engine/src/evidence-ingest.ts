import { newId, HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { chatJSON, type ChatMessage, type StepLogger } from '@pactovio/models';
import { extractText, getDocumentProxy } from 'unpdf';
import { docxBytesToPages } from './docx-text';
import { ensureEmbeddings } from './retrieve';
import { EvidenceRecord } from './schemas';

const SYSTEM = 'You read a supplier document (certificate, insurance schedule, accounts, case study, policy) and record what a bid team needs. Copy issuer, scope, expiry and every figure exactly as printed. valid_to is the expiry date as YYYY-MM-DD or null. Output JSON only.';

export interface IngestInput { workspaceId: string; filename: string; mime: string; bytes: Uint8Array; title?: string; kind?: string; validTo?: string }
export interface IngestOpts { onStep?: StepLogger; fetch?: typeof fetch }

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const isImage = (mime: string, name: string) => mime.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name);

/** Text of a PDF or DOCX in a Worker; empty string for a scanned PDF (no text layer). */
export async function documentText(i: Pick<IngestInput, 'filename' | 'mime' | 'bytes'>): Promise<string> {
  if (/\.docx$/i.test(i.filename)) return docxBytesToPages(i.bytes).join('\n');
  if (/pdf/i.test(i.mime) || /\.pdf$/i.test(i.filename)) {
    const pdf = await getDocumentProxy(new Uint8Array(i.bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  return new TextDecoder().decode(i.bytes);
}

/**
 * Evidence upload: PDF/DOCX text or an image scan (read by the vision model) becomes an `evidence` record
 * {issuer, scope, valid_to, summary}, stored in R2, chunked and embedded so retrieval can use it at once.
 */
export async function ingestEvidenceImpl(env: Env, i: IngestInput, o: IngestOpts = {}): Promise<{ evidence_id: string; status: 'ready' }> {
  if (i.bytes.byteLength > 12 * 1024 * 1024) throw new HttpError(400, 'File is larger than 12 MB', 'validation');
  const id = newId('evidence');
  const r2Key = `evidence/${i.workspaceId}/${id}/${i.filename.replace(/[^\w.\- ]/g, '_')}`;
  await env.FILES.put(r2Key, i.bytes, { httpMetadata: { contentType: i.mime } });
  let text = '';
  let msg: ChatMessage;
  if (isImage(i.mime, i.filename)) {
    const mime = i.mime.startsWith('image/') ? i.mime : 'image/png';
    msg = { role: 'user', content: [{ type: 'text', text: `Record this scanned document (file: ${i.filename}).` }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64(i.bytes)}` } }] } as unknown as ChatMessage;
  } else {
    text = (await documentText(i)).slice(0, 24_000);
    if (text.trim().length < 40) throw new HttpError(400, 'No readable text in this file. Upload it as an image (PNG or JPG) so it can be read.', 'validation');
    msg = { role: 'user', content: `Record this document (file: ${i.filename}).\n\n${text.slice(0, 12_000)}` };
  }
  const { data } = await chatJSON(EvidenceRecord, {
    env, role: 'agent', purpose: `Read evidence: ${i.filename}`, schemaName: 'evidence_record', maxTokens: 1800, onStep: o.onStep, fetch: o.fetch,
    messages: [{ role: 'system', content: SYSTEM }, msg], extra: { chat_template_kwargs: { enable_thinking: false } },
  });
  const body = [data.summary, text ? text.slice(0, 6000) : data.transcript].filter(Boolean).join('\n\n');
  await env.DB.prepare('INSERT INTO evidence (id, workspace_id, kind, title, issuer, scope, valid_to, r2_key, text, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, i.workspaceId, i.kind || data.kind, i.title || data.title, data.issuer, data.scope, i.validTo || data.valid_to, r2Key, body, JSON.stringify({ source: 'upload', filename: i.filename })).run();
  await ensureEmbeddings(env, i.workspaceId, { onStep: o.onStep, fetch: o.fetch });
  return { evidence_id: id, status: 'ready' };
}
