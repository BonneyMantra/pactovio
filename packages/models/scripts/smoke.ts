// Live smoke: ONE tiny call per model (4 total). Usage: set -a; source apps/api/.env.local; set +a; npx tsx packages/models/scripts/smoke.ts
import { z } from 'zod';
import { chat, chatJSON, embed, modelFor } from '../src';

const env = { NEBIUS_API_KEY: process.env.NEBIUS_API_KEY };
const out: Record<string, unknown>[] = [];
const run = async (name: string, model: string, fn: () => Promise<Record<string, unknown>>) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    out.push({ model, name, ok: true, ms: Date.now() - t0, ...r });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    out.push({ model, name, ok: false, ms: Date.now() - t0, status: err.status, error: String(err.message ?? e).slice(0, 240) });
  }
};
const Schema = z.object({ answer: z.number() });

await run('reason json_schema', modelFor(env, 'reason'), async () => {
  const { data, result } = await chatJSON(Schema, { env, purpose: 'smoke', role: 'reason', maxTokens: 400, messages: [{ role: 'user', content: 'What is 2+2? Return JSON.' }] });
  return { json_schema: 'accepted', answer: data.answer, tokensIn: result.tokensIn, tokensOut: result.tokensOut, cached: result.tokensCached };
});
await run('agent tool-calling', modelFor(env, 'agent'), async () => {
  const r = await chat({
    env, purpose: 'smoke', role: 'agent', maxTokens: 200, toolChoice: 'auto',
    messages: [{ role: 'user', content: 'Use the add tool to add 2 and 3.' }],
    tools: [{ type: 'function', function: { name: 'add', description: 'Add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } }],
  });
  return { tool_calling: r.toolCalls.length ? 'accepted, tool called' : 'accepted, no tool call', tool: r.toolCalls[0]?.name, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
});
await run('fast thinking-off + json_schema', modelFor(env, 'fast'), async () => {
  const { data, result } = await chatJSON(Schema, { env, purpose: 'smoke', role: 'fast', maxTokens: 200, messages: [{ role: 'user', content: 'What is 3+4? Return JSON.' }] });
  return { json_schema: 'accepted', thinking: 'off sent', answer: data.answer, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
});
await run('embed', modelFor(env, 'embed'), async () => {
  const v = await embed(['public tender requirement'], { env, purpose: 'smoke', role: 'embed' });
  return { dims: v[0]?.length };
});
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
