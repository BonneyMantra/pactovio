import { unzipSync } from 'fflate';
import { child, find, kids, parseXml, textOf, type XNode } from './xml';

export interface XlsxResult {
  pages: { n: number; text: string }[];
}

const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : '');

/** One page per sheet: `A3=Item | B3=12` per non-empty row. Reads shared strings, inline strings and numbers. */
export function extractXlsx(bytes: Uint8Array): XlsxResult {
  const parts = unzipSync(bytes, { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) });
  if (!parts['xl/workbook.xml']) throw new Error('not an XLSX: xl/workbook.xml missing');
  const shared: string[] = parts['xl/sharedStrings.xml']
    ? find(parseXml(dec(parts['xl/sharedStrings.xml'])), 'si').map((si) => find(si, 't').map(textOf).join(''))
    : [];
  const rels = new Map<string, string>();
  for (const r of find(parseXml(dec(parts['xl/_rels/workbook.xml.rels'])), 'Relationship')) {
    rels.set(r.attrs.Id ?? '', (r.attrs.Target ?? '').replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const sheets = find(parseXml(dec(parts['xl/workbook.xml'])), 'sheet');
  const pages = sheets.map((s, i) => {
    const target = rels.get(s.attrs.id ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`;
    const rows = find(parseXml(dec(parts[target])), 'row');
    const lines = rows.map((row) => kids(row, 'c').map((c) => cell(c, shared)).filter(Boolean).join(' | ')).filter(Boolean);
    return { n: i + 1, text: [`Sheet: ${s.attrs.name ?? i + 1}`, ...lines].join('\n') };
  });
  return { pages: pages.length ? pages : [{ n: 1, text: '' }] };
}

function cell(c: XNode, shared: string[]): string {
  const ref = c.attrs.r ?? '';
  const v = child(c, 'v');
  let val = '';
  if (c.attrs.t === 's') val = shared[Number(v ? textOf(v) : NaN)] ?? '';
  else if (c.attrs.t === 'inlineStr') val = find(c, 't').map(textOf).join('');
  else if (v) val = textOf(v);
  val = val.trim();
  return val ? `${ref}=${val}` : '';
}
