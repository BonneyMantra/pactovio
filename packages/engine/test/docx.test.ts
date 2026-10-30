import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fillDocx } from '../src/docx-fill';
import { docxBytesToPages } from '../src/docx-text';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const cell = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="1000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const dropdown = `<w:sdt><w:sdtPr><w:showingPlcHdr/><w:comboBox><w:listItem w:value="Choose an item."/><w:listItem w:displayText="Yes" w:value="Yes"/><w:listItem w:displayText="No" w:value="No"/><w:listItem w:displayText="Partial" w:value="Partial"/></w:comboBox></w:sdtPr><w:sdtContent><w:tc><w:p><w:r><w:rPr><w:color w:val="808080"/></w:rPr><w:t>Choose an item.</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt>`;
const formText = `<w:tc><w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:textInput><w:default w:val="Insert Response"/></w:textInput></w:ffData></w:fldChar></w:r><w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Insert Response</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:tc>`;
const row = (ref: string, req: string) => `<w:tr>${cell(ref)}${cell(req)}${cell('M')}${dropdown}${formText}</w:tr>`;

function makeForm(): Uint8Array {
  const doc = `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Tender Response Document</w:t></w:r></w:p><w:tbl>
    <w:tr>${cell('Ref No.')}${cell('Requirements')}${cell('M/D')}${cell('Y/N/P')}${cell('Comments')}</w:tr>
    ${row('B1.1.1', 'Describe your take-on approach.')}${row('B1.1.2', 'Confirm a service desk.')}${row('B2.1', 'Describe your team.')}
  </w:tbl><w:p><w:r><w:t>Signature</w:t></w:r></w:p></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'), '_rels/.rels': strToU8('<Relationships/>'),
    'word/document.xml': strToU8(doc), 'word/styles.xml': strToU8('<w:styles/>'), 'docProps/core.xml': strToU8('<cp/>'),
  });
}

describe('fillDocx: write answers into the buyer\'s own form', () => {
  it('fills the response and the Yes/No/Partial list in the matching row and keeps the structure', () => {
    const src = makeForm();
    const { bytes, report } = fillDocx(src, [
      { ref: 'B1.1.1', response: 'We will take over in six weeks.\nA weekly report follows.', compliance: 'Yes' },
      { ref: 'b1.1.2', response: 'Service desk runs 24x5 & more <ok>.', compliance: 'Partial' },
    ]);
    expect(report.filled).toEqual(['B1.1.1', 'b1.1.2']);
    const text = docxBytesToPages(bytes).join('\n');
    expect(text).toContain('B1.1.1 | Describe your take-on approach. | M | Yes | We will take over in six weeks. A weekly report follows.');
    expect(text).toContain('Service desk runs 24x5 & more <ok>.');
    expect(text).toMatch(/B1\.1\.2 \| .* \| M \| Partial \|/);
    expect(text).toContain('Tender Response Document');
    expect(text).toContain('Signature');
    // the untouched row keeps its placeholders (they are dropped from the text view, not rewritten)
    const xml = strFromU8(unzipSync(bytes)['word/document.xml']!);
    expect(xml.match(/Insert Response<\/w:t>/g)).toHaveLength(1);
    expect(xml).toContain('<w:br/>');
  });

  it('preserves every other part of the package byte for byte', () => {
    const src = makeForm();
    const before = unzipSync(src);
    const after = unzipSync(fillDocx(src, [{ ref: 'B2.1', response: 'x' }]).bytes);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const k of Object.keys(before)) if (k !== 'word/document.xml') expect(Buffer.from(after[k]!).equals(Buffer.from(before[k]!))).toBe(true);
  });

  it('reports references it could not find and never invents a row', () => {
    const { report } = fillDocx(makeForm(), [{ ref: 'Z9.9', response: 'x' }]);
    expect(report.filled).toEqual([]);
    expect(report.missed).toEqual(['Z9.9']);
  });

  it('leaves the list alone when the form does not offer the option', () => {
    const noPartial = makeForm();
    const files = unzipSync(noPartial);
    files['word/document.xml'] = strToU8(strFromU8(files['word/document.xml']!).replace(/<w:listItem w:displayText="Partial" w:value="Partial"\/>/g, ''));
    const { bytes } = fillDocx(zipSync(files), [{ ref: 'B1.1.1', compliance: 'Partial', response: 'x' }]);
    expect(strFromU8(unzipSync(bytes)['word/document.xml']!)).toContain('<w:t>Choose an item.</w:t>');
  });

  it('rejects a file that is not a DOCX', () => {
    expect(() => fillDocx(zipSync({ 'a.txt': strToU8('x') }), [])).toThrow(/Not a DOCX/);
  });

  const real = resolve(process.cwd(), 'fixtures/packs/ie-teagasc-695163/P4941_Web_Applications_TRD_LOT1.docx');
  it.skipIf(!existsSync(real))('round-trips the real Teagasc Lot 1 response form', () => {
    const src = new Uint8Array(readFileSync(real));
    const { bytes, report } = fillDocx(src, [{ ref: 'B1.1.1', response: 'Harbour Digital completes the take-on in six weeks.', compliance: 'Yes' }, { ref: 'A.6.1', response: 'Complete.', compliance: 'Yes' }]);
    expect(report.filled).toEqual(['B1.1.1', 'A.6.1']);
    expect(docxBytesToPages(bytes).join('\n')).toContain('| M | Yes | Harbour Digital completes the take-on in six weeks.');
    expect(Object.keys(unzipSync(bytes)).length).toBe(Object.keys(unzipSync(src)).length);
  });
});
