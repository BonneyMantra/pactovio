import { unzipSync } from 'fflate';
import { PackText, type ExtractPackInput } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { extractDocx } from './docx';
import { baseName, extOf, isLegacyOffice, kindOf, MIME, type PackKind } from './kinds';
import { extractPdf } from './pdf';
import { extractXlsx } from './xlsx';

export { extractDocx, extractPdf, extractXlsx };
export { isFormByStructure } from './docx';
export { kindOf } from './kinds';

type PackDoc = PackText['docs'][number];

const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 150 * 1024 * 1024;
const MAX_ZIP_DEPTH = 2;
const LEGACY_NOTE = '[Legacy binary Office file (.doc/.xls): text not extractable here. Open it as the buyer form to fill.]';
const FORM_NAME = /pric|cost|schedule|bid form|financial|response|quot/i;

async function docIdFor(r2Key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r2Key));
  return `doc_${[...new Uint8Array(d)].slice(0, 9).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type Extracted = { doc: Omit<PackDoc, 'docId' | 'filename'>; pages: number };

async function extractOne(filename: string, key: string, bytes: Uint8Array): Promise<Extracted | null> {
  const kind = kindOf(filename);
  if (!kind || kind === 'zip') return null;
  const base = { kind, isForm: false, pages: [] as PackDoc['pages'], images: [] as PackDoc['images'] };
  if (kind === 'image') return { doc: { ...base, images: [{ page: 1, r2Key: key }] }, pages: 1 };
  if (isLegacyOffice(filename)) {
    return { doc: { ...base, isForm: /form|schedule|declaration/i.test(filename), pages: [{ n: 1, text: LEGACY_NOTE }] }, pages: 1 };
  }
  if (kind === 'pdf') {
    const r = await extractPdf(bytes);
    return { doc: { ...base, pages: r.pages, images: r.imagePages.map((page) => ({ page, r2Key: key })) }, pages: r.pages.length };
  }
  if (kind === 'docx') {
    const r = extractDocx(bytes, filename);
    return { doc: { ...base, pages: r.pages, isForm: r.isForm }, pages: r.pages.length };
  }
  const r = extractXlsx(bytes);
  return { doc: { ...base, pages: r.pages, isForm: FORM_NAME.test(filename) }, pages: r.pages.length };
}

interface Row {
  id: string; filename: string; kind: PackKind; r2Key: string; pages: number | null; textKey: string | null; isForm: boolean;
}

/**
 * Download R2 objects (zip/pdf/docx/xlsx/images), extract text per page, detect response forms, store the
 * whole pack as text at `packs/<id>/text.json` and upsert `documents` rows. Idempotent: ids derive from r2 keys,
 * and a repeat call merges into the existing text.json. Runs in a Worker (fflate, unpdf, own XML parser).
 */
export async function extractPack(env: Env, input: ExtractPackInput): Promise<PackText> {
  const { tenderId, intakeId, r2Keys } = input;
  const owner = tenderId ?? intakeId;
  if (!owner) throw new Error('extractPack: tenderId or intakeId required');
  const textKey = `packs/${owner}/text.json`;
  const docs: PackDoc[] = [];
  const rows: Row[] = [];
  let budget = MAX_UNZIPPED_BYTES;

  const handle = async (filename: string, key: string, bytes: Uint8Array, depth: number): Promise<void> => {
    if (filename.startsWith('.') || bytes.byteLength > MAX_ENTRY_BYTES) return;
    const id = await docIdFor(key);
    if (kindOf(filename) === 'zip') {
      rows.push({ id, filename, kind: 'zip', r2Key: key, pages: null, textKey: null, isForm: false });
      if (depth >= MAX_ZIP_DEPTH) return;
      const entries = unzipSync(bytes, { filter: (f) => !f.name.endsWith('/') && f.originalSize <= MAX_ENTRY_BYTES && (budget -= f.originalSize) >= 0 });
      const dir = key.replace(/\.[^./]+$/, '');
      for (const [name, data] of Object.entries(entries)) {
        const entryKey = `${dir}/${name}`;
        if (kindOf(baseName(name)) === null || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
        await env.FILES.put(entryKey, data, { httpMetadata: { contentType: MIME[extOf(name)] ?? 'application/octet-stream' } });
        await handle(baseName(name), entryKey, data, depth + 1);
      }
      return;
    }
    const ex = await extractOne(filename, key, bytes).catch((err: unknown): Extracted => {
      const msg = err instanceof Error ? err.message : 'unreadable';
      return { doc: { kind: kindOf(filename)!, isForm: false, pages: [{ n: 1, text: `[Could not read ${filename}: ${msg.slice(0, 120)}]` }], images: [] }, pages: 0 };
    });
    if (!ex) return;
    docs.push({ docId: id, filename, ...ex.doc });
    rows.push({ id, filename, kind: ex.doc.kind, r2Key: key, pages: ex.pages || null, textKey, isForm: ex.doc.isForm });
  };

  for (const key of r2Keys) {
    const obj = await env.FILES.get(key);
    if (!obj) continue;
    await handle(baseName(key), key, new Uint8Array(await obj.arrayBuffer()), 0);
  }

  // Merge with a previous extraction of the same owner so repeated or incremental calls keep every document.
  const merged = new Map<string, PackDoc>();
  const prev = await env.FILES.get(textKey);
  if (prev) {
    const parsed = PackText.safeParse(await prev.json().catch(() => null));
    if (parsed.success) parsed.data.docs.forEach((d) => merged.set(d.docId, d));
  }
  docs.forEach((d) => merged.set(d.docId, d));
  const pack: PackText = { docs: [...merged.values()] };
  await env.FILES.put(textKey, JSON.stringify(pack), { httpMetadata: { contentType: 'application/json' } });

  if (rows.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO documents (id, tender_id, intake_id, workspace_id, filename, kind, r2_key, pages, text_r2_key, is_form)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, kind = excluded.kind, r2_key = excluded.r2_key,
         pages = excluded.pages, text_r2_key = excluded.text_r2_key, is_form = excluded.is_form`,
    );
    await env.DB.batch(rows.map((r) => stmt.bind(r.id, tenderId ?? null, intakeId ?? null, r.filename, r.kind, r.r2Key, r.pages, r.textKey, r.isForm ? 1 : 0)));
  }
  return pack;
}
