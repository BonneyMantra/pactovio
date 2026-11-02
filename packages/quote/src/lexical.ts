/** Deterministic lexical retrieval (idf-weighted token overlap). Fallback and complement to embeddings. Numbers and units are tokens too. */
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'with', 'in', 'on', 'at', 'is', 'be', 'must', 'we', 'our', 'need', 'per', 'by', 'it', 'as', 'from', 'than']);

export function tokens(s: string): string[] {
  return (s.toLowerCase().replace(/\[p\.\d+\]/g, ' ').match(/[a-z]+[a-z0-9-]*|\d+(?:[.,]\d+)?/g) ?? []).filter((t) => !STOP.has(t));
}

/** Scored form of lexicalRank: idf-weighted overlap plus the query terms each item matched (for explainable ranking). */
export function lexicalScores<T extends { text: string }>(query: string, items: T[], k: number): { item: T; score: number; matched: string[] }[] {
  const docs = items.map((i) => new Set(tokens(i.text)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokens(query))];
  return items
    .map((item, i) => {
      const matched = q.filter((t) => docs[i]!.has(t));
      return { item, matched, score: matched.reduce((s, t) => s + Math.log(1 + items.length / (df.get(t) ?? 1)), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function lexicalRank<T extends { text: string }>(query: string, items: T[], k: number): T[] {
  return lexicalScores(query, items, k).map((x) => x.item);
}
