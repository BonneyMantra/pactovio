/** Deterministic lexical retrieval (idf-weighted token overlap). Fallback and complement to embeddings. Numbers and units are tokens too. */
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'with', 'in', 'on', 'at', 'is', 'be', 'must', 'we', 'our', 'need', 'per', 'by', 'it', 'as', 'from', 'than']);

export function tokens(s: string): string[] {
  return (s.toLowerCase().replace(/\[p\.\d+\]/g, ' ').match(/[a-z]+[a-z0-9-]*|\d+(?:[.,]\d+)?/g) ?? []).filter((t) => !STOP.has(t));
}

export function lexicalRank<T extends { text: string }>(query: string, items: T[], k: number): T[] {
  const docs = items.map((i) => new Set(tokens(i.text)));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokens(query))];
  return items
    .map((item, i) => ({ item, score: q.reduce((s, t) => (docs[i]!.has(t) ? s + Math.log(1 + items.length / (df.get(t) ?? 1)) : s), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.item);
}
