import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '@pactovio/contracts/env';
import { matchDesignRequest } from '@pactovio/quote';

/**
 * ONE live run of matchDesignRequest on a seeded design request, recorded for the unit test (chat responses only;
 * embeddings are replaced by a deterministic embedder in tests, driven by the recorded ranking).
 * Usage (stop any wrangler dev on the same state first): tsx scripts/seed-samples-record.ts <persist-dir> <design-request-id> <out.json>
 */
const [persist, id, out] = process.argv.slice(2);
if (!persist || !id || !out) throw new Error('usage: <persist-dir> <design-request-id> <out.json>');

const chat: { schema: string; body: unknown }[] = [];
let embedCalls = 0;
const realFetch = globalThis.fetch;
const recording: typeof fetch = async (input, init) => {
  const res = await realFetch(input, init);
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/embeddings')) embedCalls++;
  if (url.endsWith('/chat/completions')) {
    const req = JSON.parse(String(init?.body ?? '{}')) as { response_format?: { json_schema?: { name?: string } } };
    chat.push({ schema: req.response_format?.json_schema?.name ?? 'unknown', body: await res.clone().json() });
  }
  return res;
};

process.stderr.write('proxy starting\n');
const proxy = await getPlatformProxy<Env>({ configPath: resolve(process.cwd(), 'wrangler.toml'), persist: { path: resolve(process.cwd(), persist) } });
process.stderr.write('proxy ready; calling match\n');
let trace: { ranks: string[][]; cands: string[] } | undefined;
const steps: unknown[] = [];
const result = await matchDesignRequest(proxy.env as Env, id, { fetch: recording, signal: AbortSignal.timeout(Number(process.env.RECORD_TIMEOUT_MS ?? 240_000)), trace: (t) => { trace = t; }, onStep: (s) => { process.stderr.write(`step ${s.purpose} ${s.status} ${s.ms}ms ${s.summary ?? ''}\n`); steps.push({ purpose: s.purpose, model: s.model, tokensIn: s.tokensIn, tokensOut: s.tokensOut, ms: s.ms, costUsd: s.costUsd }); } });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorded_at: new Date().toISOString(), design_request_id: id, http_calls: { chat: chat.length, embeddings: embedCalls }, steps, trace, chat, result }, null, 1)}\n`);
process.stderr.write(`recorded: ${chat.length} chat + ${embedCalls} embedding calls -> ${out}\n`);
await proxy.dispose();
