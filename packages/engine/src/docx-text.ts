import { unzipSync, strFromU8 } from 'fflate';

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? _;
  });
export const encodeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN = /<w:tbl>|<\/w:tbl>|<w:tc>|<\/w:tc>|<\/w:tr>|<\/w:p>|<w:lastRenderedPageBreak\/>|<w:br w:type="page"\/>|<w:tab\/>|<w:br\/>|<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g;

/**
 * Plain text of a DOCX body, split into pages (Word's own `lastRenderedPageBreak` / page breaks).
 * Tables become one line per row with cells joined by " | ", so a question's ref, text and compliance
 * columns stay on one line. Placeholder text of unfilled form fields is dropped.
 */
export function docxToPages(xml: string): string[] {
  const pages: string[] = [];
  let page: string[] = [];
  let para = '';
  let depth = 0;
  let cell = '';
  let cells: string[] = [];
  let pendingBreak = false;
  const flushPara = () => {
    const t = para.replace(/\s+/g, ' ').trim();
    para = '';
    return t;
  };
  const newPage = () => {
    if (page.length) pages.push(page.join('\n'));
    page = [];
  };
  for (const m of xml.matchAll(TOKEN)) {
    const tag = m[0];
    if (tag === '<w:tbl>') depth++;
    else if (tag === '</w:tbl>') depth = Math.max(0, depth - 1);
    else if (tag === '<w:tc>') cell = '';
    else if (tag === '</w:tc>') {
      const t = flushPara();
      if (t) cell += (cell ? ' / ' : '') + t;
      if (depth <= 1) { cells.push(cell); cell = ''; }
    } else if (tag === '</w:tr>') {
      if (depth <= 1) {
        const row = cells.filter((c) => c && c !== 'Choose an item.' && c !== 'Insert Response').join(' | ');
        if (row) { if (pendingBreak) newPage(); page.push(row); }
        pendingBreak = false;
        cells = [];
      }
    } else if (tag === '</w:p>') {
      const t = flushPara();
      if (!t) continue;
      if (depth > 0) cell += (cell ? ' / ' : '') + t;
      else page.push(t);
    } else if (tag === '<w:lastRenderedPageBreak/>' || tag === '<w:br w:type="page"/>') {
      if (depth === 0) { const t = flushPara(); if (t) page.push(t); newPage(); }
      else pendingBreak = true;
    } else if (tag === '<w:tab/>') para += ' ';
    else if (tag === '<w:br/>') para += ' ';
    else if (m[1] !== undefined) para += decodeXml(m[1]);
  }
  const t = flushPara();
  if (t) page.push(t);
  newPage();
  return pages;
}

export function docxXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('Not a DOCX: word/document.xml missing');
  return strFromU8(doc);
}

export const docxBytesToPages = (bytes: Uint8Array): string[] => docxToPages(docxXml(bytes));
