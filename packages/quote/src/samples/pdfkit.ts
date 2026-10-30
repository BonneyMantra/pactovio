import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface BuiltDoc {
  bytes: Uint8Array;
  /** Plain text of every page, one entry per line, in reading order. */
  pages: string[][];
}

const W = 595;
const H = 842;
const M = 48;

/** Tiny page-flow writer on top of pdf-lib (Helvetica, A4). Text is kept so it can be chunked and cited by page. */
export class Doc {
  private pdf!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  readonly pages: string[][] = [];

  constructor(private readonly footer: string) {}

  static async create(title: string, footer: string): Promise<Doc> {
    const d = new Doc(footer);
    d.pdf = await PDFDocument.create();
    d.pdf.setTitle(title);
    d.pdf.setProducer('Pactovio sample data');
    d.pdf.setCreationDate(new Date('2026-10-01T09:00:00Z'));
    d.font = await d.pdf.embedFont(StandardFonts.Helvetica);
    d.bold = await d.pdf.embedFont(StandardFonts.HelveticaBold);
    d.newPage();
    return d;
  }

  newPage(): void {
    this.page = this.pdf.addPage([W, H]);
    this.pages.push([]);
    this.y = H - M;
    const n = this.pages.length;
    this.page.drawText(`${this.footer}  |  page ${n}`, { x: M, y: 24, size: 7.5, font: this.font, color: rgb(0.45, 0.45, 0.45) });
  }

  private room(h: number): void {
    if (this.y - h < 48) this.newPage();
  }

  private log(s: string): void {
    this.pages[this.pages.length - 1]!.push(s);
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    let line = '';
    for (const w of text.split(/\s+/)) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  h1(text: string): this {
    this.room(40);
    this.page.drawText(text, { x: M, y: this.y - 18, size: 18, font: this.bold, color: rgb(0.08, 0.14, 0.25) });
    this.log(text);
    this.y -= 34;
    return this;
  }

  h2(text: string): this {
    this.room(30);
    this.y -= 6;
    this.page.drawText(text, { x: M, y: this.y - 12, size: 12, font: this.bold, color: rgb(0.1, 0.2, 0.35) });
    this.log(text);
    this.y -= 20;
    return this;
  }

  p(text: string, size = 10): this {
    for (const l of this.wrap(text, this.font, size, W - 2 * M)) {
      this.room(size + 5);
      this.page.drawText(l, { x: M, y: this.y - size, size, font: this.font });
      this.log(l);
      this.y -= size + 4.5;
    }
    this.y -= 4;
    return this;
  }

  bullets(items: string[]): this {
    for (const it of items) {
      const ls = this.wrap(it, this.font, 10, W - 2 * M - 14);
      ls.forEach((l, i) => {
        this.room(15);
        if (i === 0) this.page.drawText('-', { x: M + 2, y: this.y - 10, size: 10, font: this.font });
        this.page.drawText(l, { x: M + 14, y: this.y - 10, size: 10, font: this.font });
        this.log(i === 0 ? `- ${l}` : l);
        this.y -= 14.5;
      });
    }
    this.y -= 4;
    return this;
  }

  /** Two or more column table. First row is the header. Each row is logged as "a | b | c". */
  table(rows: string[][], widths: number[]): this {
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = (W - 2 * M) / total;
    const cols = widths.map((w) => w * scale);
    rows.forEach((r, ri) => {
      const cells = r.map((c, i) => this.wrap(c, ri === 0 ? this.bold : this.font, 9, cols[i]! - 8));
      const h = Math.max(...cells.map((c) => c.length)) * 12 + 8;
      this.room(h);
      if (ri === 0) this.page.drawRectangle({ x: M, y: this.y - h, width: W - 2 * M, height: h, color: rgb(0.92, 0.94, 0.97) });
      let x = M;
      cells.forEach((lines, i) => {
        lines.forEach((l, li) => this.page.drawText(l, { x: x + 4, y: this.y - 13 - li * 12, size: 9, font: ri === 0 ? this.bold : this.font }));
        x += cols[i]!;
      });
      this.page.drawLine({ start: { x: M, y: this.y - h }, end: { x: W - M, y: this.y - h }, thickness: 0.4, color: rgb(0.7, 0.72, 0.76) });
      this.log(r.join(' | '));
      this.y -= h;
    });
    this.y -= 8;
    return this;
  }

  /** Decorative certificate border for the scanned-certificate look. */
  frame(): this {
    this.page.drawRectangle({ x: 28, y: 28, width: W - 56, height: H - 56, borderColor: rgb(0.15, 0.25, 0.45), borderWidth: 2.5 });
    this.page.drawRectangle({ x: 36, y: 36, width: W - 72, height: H - 72, borderColor: rgb(0.15, 0.25, 0.45), borderWidth: 0.7 });
    return this;
  }

  center(text: string, size: number, opts: { bold?: boolean; gap?: number } = {}): this {
    const f = opts.bold ? this.bold : this.font;
    for (const l of this.wrap(text, f, size, W - 2 * M - 40)) {
      this.room(size + 8);
      this.page.drawText(l, { x: (W - f.widthOfTextAtSize(l, size)) / 2, y: this.y - size, size, font: f, color: rgb(0.1, 0.15, 0.25) });
      this.log(l);
      this.y -= size + 6;
    }
    this.y -= opts.gap ?? 4;
    return this;
  }

  async build(): Promise<BuiltDoc> {
    return { bytes: await this.pdf.save(), pages: this.pages };
  }
}
