import { b64ToBytes, deepFindArray, stripHtml, unwrap } from './util';

export interface RawFile { filename: string; mimetype: string; bytes: Uint8Array }
export interface ParsedMail {
  from: string; to: string; subject: string; body: string; receivedAt: string | null; threadId: string | null;
  /** Provider ids to download later; inline small parts already carry bytes. */
  attachments: { filename: string; mimetype: string; ref: string; bytes?: Uint8Array }[];
}

type Proxy = (req: { endpoint: string; method: 'GET'; query?: Record<string, string> }) => Promise<{ status: number; data: unknown }>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_FILES = 10;
const MAX_BYTES = 15 * 1024 * 1024;
const fail = (what: string, status: number) => new Error(`${what} failed (${status})`);

// ---- Gmail (https://developers.google.com/gmail/api/reference/rest/v1/users.messages) ----

function walkParts(part: Json | undefined, out: Json[] = []): Json[] {
  if (!part) return out;
  out.push(part);
  for (const p of (part.parts ?? []) as Json[]) walkParts(p, out);
  return out;
}

const header = (payload: Json, name: string): string => ((payload.headers ?? []) as { name: string; value: string }[]).find((h) => h.name.toLowerCase() === name)?.value ?? '';
const decodeText = (b64: string) => new TextDecoder().decode(b64ToBytes(b64));

export function parseGmailMessage(m: Json): ParsedMail {
  const payload = (m.payload ?? {}) as Json;
  const parts = walkParts(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data && !p.filename);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data && !p.filename);
  const body = plain ? decodeText(plain.body.data) : html ? stripHtml(decodeText(html.body.data)) : String(m.snippet ?? '');
  const attachments = parts
    .filter((p) => p.filename && (p.body?.attachmentId || p.body?.data))
    .map((p) => ({ filename: String(p.filename), mimetype: String(p.mimeType ?? 'application/octet-stream'), ref: String(p.body.attachmentId ?? ''), ...(p.body.data ? { bytes: b64ToBytes(p.body.data) } : {}) }));
  const internal = Number(m.internalDate);
  return {
    from: header(payload, 'from'), to: header(payload, 'to'), subject: header(payload, 'subject'), body: body.trim(),
    receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : null, threadId: m.threadId ? String(m.threadId) : null, attachments,
  };
}

export async function fetchGmail(proxy: Proxy, messageId: string): Promise<{ mail: ParsedMail; files: RawFile[] }> {
  const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`;
  const r = await proxy({ endpoint: base, method: 'GET', query: { format: 'full' } });
  if (r.status !== 200) throw fail('Gmail message fetch', r.status);
  const mail = parseGmailMessage(unwrap(r.data) as Json);
  const files: RawFile[] = [];
  let total = 0;
  for (const a of mail.attachments.slice(0, MAX_FILES)) {
    let bytes = a.bytes;
    if (!bytes && a.ref) {
      const att = await proxy({ endpoint: `${base}/attachments/${encodeURIComponent(a.ref)}`, method: 'GET' });
      const data = (unwrap(att.data) as Json | null)?.data;
      if (att.status !== 200 || typeof data !== 'string') continue;
      bytes = b64ToBytes(data);
    }
    if (!bytes || total + bytes.length > MAX_BYTES) continue;
    total += bytes.length;
    files.push({ filename: a.filename, mimetype: a.mimetype, bytes });
  }
  return { mail, files };
}

// ---- Outlook (https://learn.microsoft.com/graph/api/message-get) ----

export function parseOutlookMessage(m: Json): ParsedMail {
  const bodyObj = (m.body ?? {}) as { contentType?: string; content?: string };
  const body = bodyObj.contentType?.toLowerCase() === 'html' ? stripHtml(bodyObj.content ?? '') : (bodyObj.content ?? m.bodyPreview ?? '');
  const addr = (x: Json | undefined) => (x?.emailAddress?.address as string | undefined) ?? '';
  return {
    from: addr(m.from) || addr(m.sender), to: ((m.toRecipients ?? []) as Json[]).map(addr).join(', '), subject: String(m.subject ?? ''),
    body: String(body).trim(), receivedAt: (m.receivedDateTime as string | undefined) ?? null, threadId: m.conversationId ? String(m.conversationId) : null, attachments: [],
  };
}

export async function fetchOutlook(proxy: Proxy, messageId: string): Promise<{ mail: ParsedMail; files: RawFile[] }> {
  const base = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`;
  const r = await proxy({ endpoint: base, method: 'GET' });
  if (r.status !== 200) throw fail('Outlook message fetch', r.status);
  const msg = unwrap(r.data) as Json;
  const mail = parseOutlookMessage(msg);
  const files: RawFile[] = [];
  if (msg.hasAttachments) {
    const att = await proxy({ endpoint: `${base}/attachments`, method: 'GET', query: { $top: String(MAX_FILES) } });
    let total = 0;
    for (const a of (deepFindArray(unwrap(att.data), ['value']) ?? []) as Json[]) {
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || a.isInline || typeof a.contentBytes !== 'string') continue;
      const bytes = b64ToBytes(a.contentBytes);
      if (total + bytes.length > MAX_BYTES) continue;
      total += bytes.length;
      files.push({ filename: String(a.name ?? 'attachment'), mimetype: String(a.contentType ?? 'application/octet-stream'), bytes });
    }
  }
  return { mail, files };
}

/** "Ciarán Doyle <ciaran@x.example>" -> { name, address } */
export function splitAddress(s: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  return m ? { name: m[1]!.trim(), address: m[2]!.trim() } : { name: '', address: s.trim() };
}
