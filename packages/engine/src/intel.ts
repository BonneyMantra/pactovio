import { fromRow, HttpError, type BuyerIntel } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { chatJSON, type StepLogger } from '@pactovio/models';
import { z } from 'zod';
import { consumeTavilyCall, consumeTavilyRefresh, refundTavilyRefresh } from './caps';
import { nowIso, sha256Hex } from './util';

const TAVILY = 'https://api.tavily.com';
const CACHE_TTL = 60 * 60 * 24 * 14;

export interface TavilyResult { title: string; url: string; content: string; score?: number }

async function tavilyPost<T>(env: Env, path: string, body: unknown, f: typeof fetch): Promise<T> {
  if (!env.TAVILY_API_KEY) throw new HttpError(502, 'Tavily is not configured', 'not_configured');
  const res = await f(`${TAVILY}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new HttpError(502, `Tavily ${path} failed (${res.status})`, 'upstream');
  return (await res.json()) as T;
}

/** KV-cached by query / URL. Returns whether a live call was made. A cache hit costs no cap. */
async function cached<T>(env: Env, key: string, live: () => Promise<T>): Promise<{ value: T; live: boolean }> {
  const hit = await env.CACHE.get(key, 'json');
  if (hit) return { value: hit as T, live: false };
  await consumeTavilyCall(env.DB);
  const value = await live();
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL });
  return { value, live: true };
}

const Summary = z.object({
  summary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string(), source_idx: z.number().int() })).max(8),
});

export const buyerQuery = (buyer: string) => `${buyer} organisation remit digital systems IT applications procurement`;

async function readIntel(db: D1Database, buyerKey: string): Promise<BuyerIntel | null> {
  const r = await db.prepare('SELECT * FROM buyer_intel WHERE buyer_key = ?').bind(buyerKey).first<Record<string, unknown>>();
  return r ? fromRow<BuyerIntel>(r) : null;
}

/**
 * Buyer intelligence. `refresh: false` only reads D1 (never Tavily, so nothing runs on page load).
 * `refresh: true` searches and extracts live through Tavily (KV-cached, capped 3 per judge session and 30 calls per day),
 * then the fast model writes a summary where every fact cites a numbered source.
 */
export async function buyerIntelImpl(env: Env, buyerKey: string, opts: { refresh: boolean; sessionId?: string; onStep?: StepLogger; fetch?: typeof fetch }): Promise<BuyerIntel> {
  if (!opts.refresh) {
    const hit = await readIntel(env.DB, buyerKey);
    if (!hit) throw new HttpError(404, 'No intel for this buyer yet. POST /buyers/{id}/refresh', 'not_found');
    return hit;
  }
  const f = opts.fetch ?? fetch;
  const t = await env.DB.prepare('SELECT buyer FROM tenders WHERE buyer_key = ? LIMIT 1').bind(buyerKey).first<{ buyer: string }>();
  const buyer = t?.buyer ?? buyerKey;
  const query = buyerQuery(buyer);
  const qkey = `tavily:s:${await sha256Hex(query)}`;
  const searchCached = !!(await env.CACHE.get(qkey));
  if (!searchCached) await consumeTavilyRefresh(env.DB, opts.sessionId);
  try {
    const search = await cached(env, qkey, async () => (await tavilyPost<{ results: TavilyResult[] }>(env, '/search', { query, search_depth: 'basic', max_results: 5, include_answer: false }, f)).results.map((r) => ({ title: r.title, url: r.url, content: r.content.slice(0, 1200) })));
    const top = search.value.slice(0, 2).map((r) => r.url);
    const xkey = `tavily:x:${await sha256Hex(top.join('|'))}`;
    const extract = top.length
      ? await cached(env, xkey, async () => (await tavilyPost<{ results: { url: string; raw_content: string }[] }>(env, '/extract', { urls: top }, f)).results.map((r) => ({ url: r.url, text: r.raw_content.slice(0, 6000) })))
      : { value: [] as { url: string; text: string }[], live: false };
    const sources = search.value.map((s, i) => ({ title: s.title, url: s.url, snippet: s.content.slice(0, 280), text: extract.value.find((x) => x.url === s.url)?.text ?? s.content, idx: i }));
    const prompt = sources.map((s) => `[${s.idx}] ${s.title} (${s.url})\n${s.text}`).join('\n\n');
    const { data } = await chatJSON(Summary, {
      env, role: 'fast', purpose: `Summarise buyer intel: ${buyer}`, schemaName: 'buyer_intel', maxTokens: 1500, onStep: opts.onStep, fetch: opts.fetch,
      messages: [
        { role: 'system', content: 'You write buyer intelligence for a bid team from numbered web sources. State only what a source says. Each fact cites the index of the source that states it. Facts are short (label plus value). The summary is two or three plain sentences. No marketing language.' },
        { role: 'user', content: `Buyer: ${buyer}\n\nSOURCES\n${prompt}` },
      ],
    });
    const intel: BuyerIntel = {
      buyer_key: buyerKey,
      summary: data.summary,
      facts: data.facts.filter((x) => x.source_idx >= 0 && x.source_idx < sources.length),
      sources: sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet })),
      fetched_at: nowIso(),
    };
    await env.DB.prepare('INSERT INTO buyer_intel (buyer_key, summary, facts_json, sources_json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(buyer_key) DO UPDATE SET summary = excluded.summary, facts_json = excluded.facts_json, sources_json = excluded.sources_json, fetched_at = excluded.fetched_at')
      .bind(buyerKey, intel.summary, JSON.stringify(intel.facts), JSON.stringify(intel.sources), intel.fetched_at).run();
    return intel;
  } catch (e) {
    if (!searchCached) await refundTavilyRefresh(env.DB, opts.sessionId);
    throw e;
  }
}
