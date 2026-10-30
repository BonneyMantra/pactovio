import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { decodeXml, encodeXml } from './docx-text';

export interface FormEntry {
  ref: string;
  /** Written into the row's response field ("Insert Response" / FORMTEXT / content control). */
  response?: string;
  /** Selected in the row's Yes/No/Partial list when the list offers it; otherwise left for a human. */
  compliance?: 'Yes' | 'No' | 'Partial';
}
export interface FillReport { filled: string[]; missed: string[] }

export const normRef = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

interface Span { start: number; end: number }

/** Depth-aware row spans, so rows of nested tables are handled separately from their parent row. */
function rowSpans(xml: string): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  for (const m of xml.matchAll(/<w:tr[ >]|<\/w:tr>/g)) {
    if (m[0] === '</w:tr>') {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: m.index! + m[0].length });
    } else stack.push(m.index!);
  }
  return spans;
}

const cellText = (cellXml: string) => decodeXml([...cellXml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).trim();

const textRuns = (response: string): string =>
  response.split(/\r?\n/).map((l) => `<w:t xml:space="preserve">${encodeXml(l)}</w:t>`).join('<w:br/>');

function fillRow(row: string, e: FormEntry): { xml: string; changed: boolean } {
  let out = row;
  let changed = false;
  if (e.compliance && /w:listItem[^>]*w:displayText="[^"]*"/.test(out) && out.includes(`w:displayText="${e.compliance}"`) && /<w:t(?: [^>]*)?>Choose an item\.<\/w:t>/.test(out)) {
    out = out.replace(/<w:t(?: [^>]*)?>Choose an item\.<\/w:t>/, `<w:t>${e.compliance}</w:t>`);
    changed = true;
  }
  if (e.response && /<w:t(?: [^>]*)?>Insert Response<\/w:t>/.test(out)) {
    out = out.replace(/<w:t(?: [^>]*)?>Insert Response<\/w:t>/, () => textRuns(e.response!));
    changed = true;
  }
  if (changed) out = out.replace(/<w:showingPlcHdr\/>/g, '').replace(/<w:color w:val="808080"\/>/g, '');
  return { xml: out, changed };
}

/**
 * Write answers into the buyer's own DOCX form: find each table row whose first cell is the answer's reference
 * and replace the placeholder text in place. Every other byte of every other part is preserved.
 */
export function fillDocx(bytes: Uint8Array, entries: FormEntry[]): { bytes: Uint8Array; report: FillReport } {
  const files = unzipSync(bytes);
  const docBytes = files['word/document.xml'];
  if (!docBytes) throw new Error('Not a DOCX: word/document.xml missing');
  let xml = strFromU8(docBytes);
  const want = new Map(entries.map((e) => [normRef(e.ref), e]));
  const filled = new Set<string>();
  const edits: { span: Span; xml: string }[] = [];
  const claimed: Span[] = [];
  for (const span of rowSpans(xml).sort((a, b) => a.start - b.start)) {
    if (claimed.some((c) => span.start >= c.start && span.end <= c.end)) continue;
    const row = xml.slice(span.start, span.end);
    const firstCell = /<w:tc>[\s\S]*?<\/w:tc>/.exec(row)?.[0];
    if (!firstCell) continue;
    const key = normRef(cellText(firstCell));
    const entry = want.get(key);
    if (!entry) continue;
    const r = fillRow(row, entry);
    if (r.changed) { edits.push({ span, xml: r.xml }); claimed.push(span); filled.add(key); }
  }
  for (const ed of edits.sort((a, b) => b.span.start - a.span.start)) xml = xml.slice(0, ed.span.start) + ed.xml + xml.slice(ed.span.end);
  files['word/document.xml'] = strToU8(xml);
  return {
    bytes: zipSync(files, { level: 6 }),
    report: { filled: entries.filter((e) => filled.has(normRef(e.ref))).map((e) => e.ref), missed: entries.filter((e) => !filled.has(normRef(e.ref))).map((e) => e.ref) },
  };
}
