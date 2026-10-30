/**
 * Build a PackText JSON from a real pack in fixtures/packs/<slug>/ (gitignored) until lane A's extractPack serves it.
 * Usage: tsx scripts/build-fixture.ts ie-teagasc-695163 tnd_sample_teagasc_p4941
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PackText } from '@pactovio/contracts';
import { docxBytesToPages } from '../src/docx-text';

const [slug, tenderId] = process.argv.slice(2);
if (!slug || !tenderId) throw new Error('usage: build-fixture <slug> <tenderId>');
const dir = resolve(process.cwd(), '../../fixtures/packs', slug);
const ID_BY_FILE: Record<string, string> = {
  'P4941 - CFT for Web applications_services.docx': 'doc_sample_teagasc_cft',
  'P4941_Web_Applications_Requirements.pdf': 'doc_sample_teagasc_req',
  'P4941_Web_Applications_TRD_LOT1.docx': 'doc_sample_teagasc_trd1',
  'P4941_Web_Applications_TRD_LOT2.docx': 'doc_sample_teagasc_trd2',
  'P4941_Web_Applications_TRD_LOT3.docx': 'doc_sample_teagasc_trd3',
  'P4941 Clarifications 21102026A.pdf': 'doc_sample_teagasc_clar',
  'NMP Architecture diagram P4941 LOT2.png': 'doc_sample_teagasc_nmp',
};
const docs: PackText['docs'] = [];
for (const f of readdirSync(dir).sort()) {
  const docId = ID_BY_FILE[f];
  if (!docId) continue;
  const path = join(dir, f);
  if (f.endsWith('.docx')) {
    const pages = docxBytesToPages(new Uint8Array(readFileSync(path)));
    docs.push({ docId, filename: f, kind: 'docx', isForm: /TRD/.test(f), pages: pages.map((text, i) => ({ n: i + 1, text })), images: [] });
  } else if (f.endsWith('.pdf')) {
    const txt = execFileSync('pdftotext', ['-layout', path, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    const pages = txt.split('\f').map((t) => t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    while (pages.length && !pages[pages.length - 1]) pages.pop();
    docs.push({ docId, filename: f, kind: 'pdf', isForm: false, pages: pages.map((text, i) => ({ n: i + 1, text })), images: [] });
  } else if (f.endsWith('.png')) {
    docs.push({ docId, filename: f, kind: 'image', isForm: false, pages: [], images: [{ page: 1, r2Key: `tenders/${tenderId}/${f}` }] });
  }
}
const out: PackText = { docs };
writeFileSync(join(dir, 'packtext.json'), JSON.stringify(out));
for (const d of docs) process.stderr.write(`${d.filename}: ${d.pages.length} pages, ${d.pages.reduce((a, p) => a + p.text.length, 0)} chars\n`);
