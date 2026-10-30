import { strToU8, zipSync } from 'fflate';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const para = (t: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
export const cell = (t: string) => `<w:tc>${t ? para(t) : '<w:p/>'}</w:tc>`;
export const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
export const table = (...rows: string[]) => `<w:tbl>${rows.join('')}</w:tbl>`;
export const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
export const control = (alias: string, text = '', placeholder = true) =>
  `<w:sdt><w:sdtPr><w:alias w:val="${alias}"/>${placeholder ? '<w:showingPlcHdr/>' : ''}</w:sdtPr><w:sdtContent><w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p></w:sdtContent></w:sdt>`;

export function docx(bodyXml: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`),
  });
}

export function xlsx(sheets: Record<string, (string | number)[][]>): Uint8Array {
  const names = Object.keys(sheets);
  const strings: string[] = [];
  const col = (i: number) => String.fromCharCode(65 + i);
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(`<workbook xmlns="x" xmlns:r="r"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  names.forEach((n, si) => {
    const rows = sheets[n]!.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (typeof v === 'number') return `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`;
      strings.push(v);
      return `<c r="${col(ci)}${ri + 1}" t="s"><v>${strings.length - 1}</v></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`);
  return zipSync(files);
}

export const zip = (files: Record<string, Uint8Array>) => zipSync(files);
