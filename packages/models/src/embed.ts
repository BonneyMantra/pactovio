import { client, modelFor } from './client';
import { costUsd } from './prices';
import { liveLimiter } from './limiter';
import type { CallOptions } from './types';

/** Embeddings via MODEL_EMBED (Qwen3-Embedding-8B). Batches inputs; there is no reranker, so rank with `cosine`. */
export async function embed(texts: string[], o: CallOptions): Promise<number[][]> {
  const model = modelFor(o.env, 'embed', o.model);
  const out: number[][] = [];
  const t0 = Date.now();
  let tokens = 0;
  for (let i = 0; i < texts.length; i += 32) {
    const res = await liveLimiter(() => client(o).embeddings.create({ model, input: texts.slice(i, i + 32), encoding_format: 'float' }));
    tokens += res.usage?.prompt_tokens ?? 0;
    for (const d of res.data) out.push(d.embedding as number[]);
  }
  await o.onStep?.({ purpose: o.purpose, model, status: 'ok', tokensIn: tokens, tokensOut: 0, tokensCached: 0, ms: Date.now() - t0, costUsd: costUsd(model, tokens, 0) });
  return out;
}

/** Cosine similarity. Vectors of different lengths (e.g. 256-dim Matryoshka rows beside 4096-dim ones) are not comparable: score 0. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function rankByCosine<T>(query: number[], items: { item: T; embedding: number[] }[], topK = 5): { item: T; score: number }[] {
  return items.map((x) => ({ item: x.item, score: cosine(query, x.embedding) })).sort((a, b) => b.score - a.score).slice(0, topK);
}
