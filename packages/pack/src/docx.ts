import { unzipSync } from 'fflate';
import { child, kids, parseXml, textOf, type XNode } from './xml';

export interface FormSignals {
  contentControls: number;
  emptyAnswerCells: number;
  responseHeadings: number;
  placeholders: number;
}
export interface DocxResult {
  pages: { n: number; text: string }[];
  isForm: boolean;
  signals: FormSignals;
}

const PLACEHOLDER = /\[(?:insert|tenderer|enter|please|name|date|describe|provide)[^\]]{0,80}\]|click or tap here to enter text|_{6,}|\.{10,}/i;
const RESPONSE_HEADING = /\bresponse(s)?\b|\banswers?\b/i;
export const RESPONSE_MARK = '[[RESPONSE]]';

class Ctx {
  pages: string[][] = [[]];
  pendingBreak = false;
  sig: FormSignals = { contentControls: 0, emptyAnswerCells: 0, responseHeadings: 0, placeholders: 0 };
  private cur = () => this.pages[this.pages.length - 1]!;
  newPage() {
    if (this.cur().some((l) => l.trim())) this.pages.push([]);
  }
  emit(line: string) {
    if (this.pendingBreak) {
      this.pendingBreak = false;
      this.newPage();
    }
    this.cur().push(line);
  }
}

/** Inline content of a paragraph, as text segments split at page breaks. */
function inline(node: XNode, segs: string[], ctx: Ctx): void {
  for (const c of node.children) {
    switch (c.name) {
      case 'r':
        for (const rc of c.children) {
          if (rc.name === 't') segs[segs.length - 1] += textOf(rc);
          else if (rc.name === 'tab') segs[segs.length - 1] += '\t';
          else if (rc.name === 'noBreakHyphen') segs[segs.length - 1] += '-';
          else if (rc.name === 'br') {
            if (rc.attrs.type === 'page') segs.push('');
            else segs[segs.length - 1] += '\n';
          } else if (rc.name === 'lastRenderedPageBreak') segs.push('');
        }
        break;
      case 'sdt': {
        const pr = child(c, 'sdtPr');
        if (pr && child(pr, 'docPartObj')) break; // TOC and building blocks
        const body = child(c, 'sdtContent');
        const sub = ['']; // page breaks inside a control are ignored
        if (body) inline(body, sub, ctx);
        const inner = sub.join('').trim();
        const chk = pr && child(pr, 'checkbox');
        if (chk) {
          const on = child(chk, 'checked')?.attrs.val === '1';
          segs[segs.length - 1] += on ? '[x]' : '[ ]';
          ctx.sig.contentControls++;
          break;
        }
        ctx.sig.contentControls++;
        const alias = pr && (child(pr, 'alias')?.attrs.val ?? child(pr, 'tag')?.attrs.val);
        const placeholder = pr && child(pr, 'showingPlcHdr');
        segs[segs.length - 1] += placeholder || !inner ? `[[RESPONSE${alias ? `: ${alias}` : ''}]]` : inner;
        break;
      }
      case 'hyperlink': case 'smartTag': case 'ins': case 'fldSimple': case 'sdtContent':
        inline(c, segs, ctx);
        break;
      default:
    }
  }
}

function paragraph(p: XNode, ctx: Ctx): string[] {
  const segs = [''];
  inline(p, segs, ctx);
  const ppr = child(p, 'pPr');
  const style = (ppr && child(ppr, 'pStyle')?.attrs.val) || '';
  const lvl = /^(?:Heading|Title)\s*(\d)?/i.exec(style);
  const heading = !!lvl || (ppr && child(ppr, 'outlineLvl') !== undefined);
  const isList = !!(ppr && child(ppr, 'numPr'));
  const out = segs.map((s, i) => {
    const t = s.replace(/[ \t]+/g, (m) => (m.includes('\t') ? '\t' : ' ')).trim();
    if (i === 0 && t) {
      if (heading) return `${'#'.repeat(Math.min(Number(lvl?.[1] ?? 1), 4))} ${t}`;
      if (isList) return `- ${t}`;
    }
    return t;
  });
  const full = out.join(' ');
  if (heading && full.length < 120 && RESPONSE_HEADING.test(full)) ctx.sig.responseHeadings++;
  if (!heading && PLACEHOLDER.test(full) && !full.includes('[[RESPONSE')) ctx.sig.placeholders++;
  return out;
}

function blockLines(node: XNode, ctx: Ctx, flat: boolean): string[] {
  const lines: string[] = [];
  for (const c of node.children) {
    if (c.name === 'p') {
      const segs = paragraph(c, ctx);
      if (flat) {
        if (segs.length > 1) ctx.pendingBreak = true;
        const t = segs.join(' ').trim();
        if (t) lines.push(t);
      } else segs.forEach((s, i) => {
        if (i > 0) ctx.newPage();
        if (s || i === 0) ctx.emit(s);
      });
    } else if (c.name === 'tbl') {
      const rows = table(c, ctx);
      if (flat) lines.push(...rows);
      else rows.forEach((r) => ctx.emit(r));
    } else if (c.name === 'sdt') {
      const pr = child(c, 'sdtPr');
      const body = child(c, 'sdtContent');
      if (!body || (pr && child(pr, 'docPartObj'))) continue;
      ctx.sig.contentControls++;
      const inner = blockLines(body, ctx, true);
      const alias = pr && (child(pr, 'alias')?.attrs.val ?? child(pr, 'tag')?.attrs.val);
      const out = inner.length && !(pr && child(pr, 'showingPlcHdr')) ? inner : [`[[RESPONSE${alias ? `: ${alias}` : ''}]]`];
      if (flat) lines.push(...out);
      else out.forEach((l) => ctx.emit(l));
    }
  }
  return lines;
}

function table(tbl: XNode, ctx: Ctx): string[] {
  const trs = kids(tbl, 'tr');
  return trs.map((tr, ri) => {
    const cells = kids(tr, 'tc').map((tc) => blockLines(tc, ctx, true).join(' / ').trim());
    if (ri > 0 && cells.length >= 2 && cells.slice(0, -1).some(Boolean) && !cells[cells.length - 1]) {
      cells[cells.length - 1] = RESPONSE_MARK;
      ctx.sig.emptyAnswerCells++;
    }
    return cells.some(Boolean) ? `| ${cells.join(' | ')} |` : '';
  }).filter(Boolean);
}

const FORM_NAME_HINT = /response|\bTRD\b|questionnaire|(^|[^a-z])forms?([^a-z]|$)|template|schedule/i;

/**
 * A response form has many answer slots per page: content controls (weight 3), empty last cells in table rows and
 * "Response" headings (weight 20). A file name like "Tender Response Document" lowers the bar.
 */
export function isFormByStructure(s: FormSignals, pageCount: number, filename = ''): boolean {
  const score = s.contentControls * 3 + s.emptyAnswerCells + s.responseHeadings * 20;
  const density = score / Math.max(1, pageCount);
  return FORM_NAME_HINT.test(filename) ? score >= 8 && density >= 0.5 : score >= 40 && density >= 5;
}

/** Text per page (page breaks from the rendered layout) plus response-form detection from the XML. */
export function extractDocx(bytes: Uint8Array, filename = ''): DocxResult {
  const parts = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = parts['word/document.xml'];
  if (!xml) throw new Error('not a DOCX: word/document.xml missing');
  const doc = parseXml(new TextDecoder().decode(xml));
  const body = child(child(doc, 'document') ?? doc, 'body');
  const ctx = new Ctx();
  if (body) blockLines(body, ctx, false);
  const pages = ctx.pages.map((l) => l.join('\n').replace(/\n{3,}/g, '\n\n').trim()).filter(Boolean).map((text, i) => ({ n: i + 1, text }));
  const out = pages.length ? pages : [{ n: 1, text: '' }];
  return { pages: out, isForm: isFormByStructure(ctx.sig, out.length, filename), signals: ctx.sig };
}
