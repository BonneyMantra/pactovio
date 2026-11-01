import { strToU8, zipSync } from 'fflate';
import type { Quote } from '@pactovio/contracts';

export interface QuoteDoc { quote: Quote; seller: string; customer: string; tax_label: string; tax_bp: number; subject: string | null; sample?: boolean }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Integer minor units to "1,234.56" without floats. */
export function fmtMinor(n: number, withGroups = true): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const whole = String(Math.floor(a / 100));
  return `${sign}${withGroups ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole}.${String(a % 100).padStart(2, '0')}`;
}

const p = (t: string, o: { b?: boolean; sz?: number } = {}) =>
  `<w:p><w:r><w:rPr>${o.b ? '<w:b/>' : ''}<w:sz w:val="${(o.sz ?? 11) * 2}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const cell = (t: string, w: number, b = false, right = false) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p>${right ? '<w:pPr><w:jc w:val="right"/></w:pPr>' : ''}<w:r><w:rPr>${b ? '<w:b/>' : ''}<w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`;
const row = (cs: string[]) => `<w:tr>${cs.join('')}</w:tr>`;

export function quoteDocx(d: QuoteDoc): Uint8Array {
  const q = d.quote;
  const W = [3000, 1000, 1700, 1500, 1800];
  const tbl = (rows: string[]) => `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="B0B6C0"/>`).join('')}</w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
  const head = row(['Item', 'Qty', `Unit price (${q.currency})`, 'Discount', `Line total (${q.currency})`].map((h, i) => cell(h, W[i]!, true, i > 0)));
  const lines = q.lines.map((l) => row([`${l.sku ? `${l.sku}  ` : ''}${l.description}`, String(l.qty), fmtMinor(l.unit_price_minor), fmtMinor(l.discount_minor), fmtMinor(l.line_total_minor)].map((t, i) => cell(t, W[i]!, false, i > 0))));
  const tot = (label: string, v: number, b = false) => row([cell(label, W[0]! + W[1]! + W[2]! + W[3]!, b, true), cell(fmtMinor(v), W[4]!, b, true)]);
  const body = [
    p('QUOTATION', { b: true, sz: 20 }), p(`${d.seller}  |  Quote ${q.id}`), p(`Prepared for: ${d.customer}`),
    ...(d.subject ? [p(`Subject: ${d.subject}`)] : []), p(`Valid until: ${q.valid_until?.slice(0, 10) ?? 'n/a'}   Currency: ${q.currency}`), p(' '),
    tbl([head, ...lines, tot('Subtotal', q.subtotal_minor), tot('Volume discount', -q.discount_minor), tot(d.tax_label, q.tax_minor), tot('Total', q.total_minor, true)]),
    p(' '), p('Commercial terms, delivery dates and payment terms require supplier confirmation. Taxes are shown separately.', { sz: 9 }),
    ...(d.sample ? [p('Sample company (fictional): sample data created for demonstration.', { sz: 8 })] : []),
  ].join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`),
  });
}

const col = (i: number) => String.fromCharCode(65 + i);
const s = (r: number, c: number, t: string, style = 0) => `<c r="${col(c)}${r}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(t)}</t></is></c>`;
/** Money as an exact decimal string in a numeric cell (style 2 = #,##0.00). */
const m = (r: number, c: number, n: number, style = 2) => `<c r="${col(c)}${r}" s="${style}"><v>${fmtMinor(n, false)}</v></c>`;
const n = (r: number, c: number, v: number) => `<c r="${col(c)}${r}"><v>${v}</v></c>`;

export function quoteXlsx(d: QuoteDoc): Uint8Array {
  const q = d.quote;
  const rows: string[][] = [];
  rows.push([s(1, 0, `Quotation ${q.id}`, 1)], [s(2, 0, `${d.seller}  |  Prepared for ${d.customer}`)], [s(3, 0, `Valid until ${q.valid_until?.slice(0, 10) ?? 'n/a'}  |  Currency ${q.currency}`)], []);
  rows.push(['SKU', 'Description', 'Qty', `Unit price (${q.currency})`, 'Discount', `Line total (${q.currency})`].map((h, i) => s(5, i, h, 1)));
  q.lines.forEach((l, i) => { const r = 6 + i; rows.push([s(r, 0, l.sku ?? ''), s(r, 1, l.description), n(r, 2, l.qty), m(r, 3, l.unit_price_minor), m(r, 4, l.discount_minor), m(r, 5, l.line_total_minor)]); });
  let r = 6 + q.lines.length + 1;
  for (const [label, v, st] of [['Subtotal', q.subtotal_minor, 2], ['Volume discount', -q.discount_minor, 2], [d.tax_label, q.tax_minor, 2], ['Total', q.total_minor, 3]] as const) { rows.push([s(r, 4, label, st === 3 ? 1 : 0), m(r, 5, v, st)]); r++; }
  const sheetRows = rows.map((cs, i) => (cs.length ? `<row r="${i + 1}">${cs.join('')}</row>` : '')).join('');
  const xml = (b: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${b}`;
  return zipSync({
    '[Content_Types].xml': strToU8(xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')),
    '_rels/.rels': strToU8(xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')),
    'xl/workbook.xml': strToU8(xml('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Quote" sheetId="1" r:id="rId1"/></sheets></workbook>')),
    'xl/_rels/workbook.xml.rels': strToU8(xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')),
    'xl/styles.xml': strToU8(xml('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>')),
    'xl/worksheets/sheet1.xml': strToU8(xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="48" customWidth="1"/><col min="3" max="6" width="18" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`)),
  });
}

export const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;
