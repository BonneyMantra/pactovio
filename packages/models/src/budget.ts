import { costUsd } from './prices';

/**
 * Hard daily spend cap on Token Factory, enforced inside the model client's fetch so it covers every call the app can
 * make: chat, JSON, streaming agent turns, embeddings, retries and fallbacks, from routes, workflows, crons and webhooks.
 * Each request reserves its worst-case cost first (atomic, refused if the day's total would pass the cap), then the
 * reservation is settled to the actual token cost at list prices. The day resets at 00:00 UTC (08:00 MYT).
 */
export const DEFAULT_DAILY_CAP_USD = 0.25;
export const LIMIT_MESSAGE = 'Daily limit reached. Try again after 08:00 MYT.';
export const OFF_MESSAGE = 'Model calls are switched off.';
const KEY = 'tf_usd_micros';
const KILL_KEY = 'config:models_disabled';

interface BudgetEnv {
  DB?: D1Database;
  CACHE?: KVNamespace;
  ENVIRONMENT?: string;
  MODELS_DISABLED?: string;
  MODEL_DAILY_CAP_USD?: string;
}

export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
const micros = (usd: number): number => Math.ceil(usd * 1_000_000);
export const capUsd = (env: BudgetEnv): number => {
  const v = Number(env.MODEL_DAILY_CAP_USD);
  return Number.isFinite(v) && v >= 0 && env.MODEL_DAILY_CAP_USD !== undefined && env.MODEL_DAILY_CAP_USD !== '' ? v : DEFAULT_DAILY_CAP_USD;
};

export async function modelsDisabled(env: BudgetEnv): Promise<boolean> {
  if (env.MODELS_DISABLED === '1' || env.MODELS_DISABLED === 'true') return true;
  return (await env.CACHE?.get(KILL_KEY).catch(() => null)) === '1';
}

export async function spentTodayUsd(env: BudgetEnv): Promise<number> {
  if (!env.DB) return 0;
  const r = await env.DB.prepare('SELECT count FROM limits_counters WHERE key = ? AND day = ?').bind(KEY, utcDay()).first<{ count: number }>();
  return (r?.count ?? 0) / 1_000_000;
}

/** Atomically add `usd` to today's total unless that would pass the cap. Returns false when refused. */
export async function reserve(env: BudgetEnv, usd: number): Promise<boolean> {
  if (!env.DB) return env.ENVIRONMENT !== 'production'; // tests and scripts without D1; production always has it
  const add = Math.max(1, micros(usd)); // every request counts, even a sub-micro-dollar embedding
  const r = await env.DB.prepare(
    'INSERT INTO limits_counters (key, day, count) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4 ON CONFLICT(key, day) DO UPDATE SET count = count + excluded.count WHERE count + excluded.count <= ?4',
  ).bind(KEY, utcDay(), add, micros(capUsd(env))).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Correct a reservation to the actual cost (may be negative: refunds an over-estimate or a failed request). */
export async function settle(env: BudgetEnv, deltaUsd: number): Promise<void> {
  if (!env.DB || deltaUsd === 0) return;
  const d = deltaUsd > 0 ? micros(deltaUsd) : -Math.floor(-deltaUsd * 1_000_000);
  await env.DB.prepare('UPDATE limits_counters SET count = MAX(0, count + ?) WHERE key = ? AND day = ?').bind(d, KEY, utcDay()).run().catch(() => undefined);
}

/** Worst case for one request: the whole prompt uncached plus the full output allowance, at list prices. */
export function estimateUsd(body: Record<string, unknown>): number {
  const model = String(body.model ?? '');
  const promptChars = JSON.stringify(body.messages ?? body.input ?? '').length;
  const outTokens = Number(body.max_tokens) || (body.input !== undefined ? 0 : 4096);
  return costUsd(model, Math.ceil(promptChars / 3), outTokens, 0, false);
}

const refusal = (message: string, code: string): Response =>
  new Response(JSON.stringify({ error: { message, code, type: 'spend_cap' } }), { status: 402, headers: { 'content-type': 'application/json' } });

/** True for the client error our fetch wrapper produces (402 from the cap or the kill switch). */
export function isBudgetError(e: unknown): boolean {
  const x = e as { status?: number; code?: string; error?: { code?: string } } | null;
  return !!x && x.status === 402 && ['cap_daily', 'models_off'].includes(String(x.code ?? x.error?.code ?? ''));
}
export const budgetMessage = (e: unknown): string =>
  ((e as { code?: string; error?: { code?: string } }).code ?? (e as { error?: { code?: string } }).error?.code) === 'models_off' ? OFF_MESSAGE : LIMIT_MESSAGE;

function usageCost(model: string, u: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined): number | null {
  if (!u || u.prompt_tokens === undefined) return null;
  return costUsd(model, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, u.prompt_tokens_details?.cached_tokens ?? 0, false);
}

/** Wrap the client's fetch with the kill switch and the daily cap. */
export function budgetedFetch(env: BudgetEnv, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (await modelsDisabled(env)) return refusal(OFF_MESSAGE, 'models_off');
    let body: Record<string, unknown> = {};
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}; } catch { body = {}; }
    const model = String(body.model ?? '');
    const est = estimateUsd(body);
    if (!(await reserve(env, est))) return refusal(LIMIT_MESSAGE, 'cap_daily');
    let res: Response;
    try { res = await inner(input, init); } catch (e) { await settle(env, -est); throw e; }
    if (!res.ok) { await settle(env, -est); return res; }
    if (body.stream) {
      // Read usage from the final SSE chunk (stream_options.include_usage) on a tee, then settle.
      const [a, b] = res.body ? res.body.tee() : [null, null];
      if (b) void streamUsage(b).then((u) => settle(env, (u === null ? est : usageCost(model, u) ?? est) - est)).catch(() => undefined);
      return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    const actual = usageCost(model, ((await res.clone().json().catch(() => ({}))) as { usage?: never }).usage);
    await settle(env, (actual ?? est) - est);
    return res;
  }) as typeof fetch;
}

async function streamUsage(stream: ReadableStream<Uint8Array>): Promise<Parameters<typeof usageCost>[1] | null> {
  const reader = stream.getReader(); const dec = new TextDecoder(); let buf = ''; let usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.startsWith('data:') || l.includes('[DONE]')) continue;
      try { const j = JSON.parse(l.slice(5)) as { usage?: never }; if (j.usage) usage = j.usage; } catch { /* partial line */ }
    }
  }
  return usage;
}
