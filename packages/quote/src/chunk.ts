/** Chunking of per-page text into retrievable pieces. Every chunk starts with a `[p.N]` page marker so a hit can be cited. */
export interface Chunk { seq: number; page: number; text: string }

export const PAGE_MARK = /^(?:.*?)\[p\.(\d+)\]/;

/**
 * Datasheets: one chunk per table or bullet line, prefixed `SKU [p.N]`, so a spec row can be quoted exactly.
 * Other documents: lines grouped up to ~500 characters per page.
 */
export function chunkPages(pages: string[][], opts: { prefix?: string; perLine?: boolean } = {}): Chunk[] {
  const out: Chunk[] = [];
  const pre = opts.prefix ? `${opts.prefix} ` : '';
  pages.forEach((lines, i) => {
    const page = i + 1;
    const clean = lines.map((l) => l.trim()).filter(Boolean);
    if (opts.perLine) {
      for (const l of clean) if (l.includes(' | ') || l.startsWith('- ') || l.length > 40) out.push({ seq: out.length, page, text: `${pre}[p.${page}] ${l}` });
      return;
    }
    let buf = '';
    const flush = () => { if (buf) out.push({ seq: out.length, page, text: `${pre}[p.${page}] ${buf.trim()}` }); buf = ''; };
    for (const l of clean) {
      if (buf.length + l.length > 500) flush();
      buf += `${l} `;
    }
    flush();
  });
  return out;
}

export function pageOf(chunkText: string): number | null {
  const m = PAGE_MARK.exec(chunkText);
  return m ? Number(m[1]) : null;
}
