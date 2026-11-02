/** Deterministic date extraction from pasted tender/RFQ text. Each item quotes the sentence it came from. */
export interface ExtractedDeadline { title: string; due_at: string; excerpt: string; confidence: 'explicit' }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const PATTERNS: { re: RegExp; parts: (m: RegExpExecArray) => [number, number, number] }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parts: (m) => [+m[1]!, +m[2]!, +m[3]!] },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH},?\\s+(\\d{4})\\b`, 'gi'), parts: (m) => [+m[3]!, monthNo(m[2]!), +m[1]!] },
  { re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), parts: (m) => [+m[3]!, monthNo(m[1]!), +m[2]!] },
  // Numeric dates are read day-first (12/03/2026 is 12 March), the convention in EU/UK/MY tender documents.
  { re: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, parts: (m) => [+m[3]!, +m[2]!, +m[1]!] },
];

function monthNo(name: string): number { return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1; }

function isoDay(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}

/** The sentence (or line) around an index, capped for display. */
function sentenceAt(text: string, start: number, end: number): { from: number; to: number } {
  let from = start, to = end;
  while (from > 0 && !/[.!?\n]/.test(text[from - 1]!) && start - from < 280) from--;
  while (to < text.length && !/[!?\n]/.test(text[to]!) && !(text[to] === '.' && /\s|$/.test(text[to + 1] ?? '')) && to - end < 280) to++;
  return { from, to: Math.min(text.length, to + 1) };
}

function titleFrom(sentence: string, date: string): string {
  const stripped = sentence.replace(date, ' ').replace(/\b(on|by|before|until|no later than|is|are|will be|at|the)\s*[:,.-]?\s*$/i, '')
    .replace(/[\s:;,.–—-]+$/g, '').replace(/^[\s\-•*\d.)]+/, '').replace(/\s+/g, ' ').trim();
  const head = stripped.length > 90 ? `${stripped.slice(0, 87).replace(/\s+\S*$/, '')}...` : stripped;
  return head ? head[0]!.toUpperCase() + head.slice(1) : 'Date in document';
}

export function extractDeadlines(text: string, limit = 50): ExtractedDeadline[] {
  const found: { at: number; item: ExtractedDeadline }[] = [];
  const taken: [number, number][] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      const s = m.index, e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      const [y, mo, d] = p.parts(m);
      const due = isoDay(y, mo, d);
      if (!due) continue;
      taken.push([s, e]);
      const { from, to } = sentenceAt(text, s, e);
      const sentence = text.slice(from, to).replace(/\s+/g, ' ').trim();
      found.push({ at: s, item: { title: titleFrom(sentence, m[0]), due_at: due, excerpt: sentence.slice(0, 600), confidence: 'explicit' } });
    }
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).map((f) => f.item)
    .filter((i) => { const k = `${i.due_at}|${i.excerpt}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limit);
}
