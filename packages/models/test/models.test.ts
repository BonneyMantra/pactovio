import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chat, chatJSON, costUsd, cosine, createLimiter, rankByCosine, stripThinking } from '../src';

const env = { NEBIUS_API_KEY: 'test-key' };
function fakeFetch(replies: string[], seen: Record<string, unknown>[] = []) {
  let i = 0;
  return (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(init.body as string));
    const content = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('chat', () => {
  it('sends thinking-off for the fast model, flex tier, and logs a step', async () => {
    const seen: Record<string, unknown>[] = [];
    const steps: unknown[] = [];
    const r = await chat({ env, role: 'fast', flex: true, purpose: 'triage', messages: [{ role: 'user', content: 'hi' }], fetch: fakeFetch(['ok'], seen), onStep: (s) => { steps.push(s); } });
    expect(seen[0]!.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seen[0]!.service_tier).toBe('flex');
    expect(seen[0]!.model).toBe('nvidia/Nemotron-3_5-Lightning');
    expect(r.tokensCached).toBe(60);
    expect(steps).toHaveLength(1);
  });
  it('does not send thinking-off for the reasoning model', async () => {
    const seen: Record<string, unknown>[] = [];
    await chat({ env, role: 'reason', purpose: 'p', messages: [{ role: 'user', content: 'hi' }], fetch: fakeFetch(['ok'], seen) });
    expect(seen[0]!.chat_template_kwargs).toBeUndefined();
  });
  it('logs an error step and rethrows when the API fails', async () => {
    const steps: { status: string }[] = [];
    const bad = (async () => new Response('{"error":{"message":"nope"}}', { status: 400 })) as unknown as typeof fetch;
    await expect(chat({ env, purpose: 'p', messages: [{ role: 'user', content: 'x' }], fetch: bad, onStep: (s) => { steps.push(s); } })).rejects.toBeTruthy();
    expect(steps[0]!.status).toBe('error');
  });
  it('requires an API key', async () => {
    await expect(chat({ env: {}, purpose: 'p', messages: [] })).rejects.toThrow(/NEBIUS_API_KEY/);
  });
});

describe('chatJSON', () => {
  const S = z.object({ answer: z.number() });
  it('retries once with the validation error, then succeeds', async () => {
    const seen: Record<string, unknown>[] = [];
    const { data } = await chatJSON(S, { env, purpose: 'p', messages: [{ role: 'user', content: 'q' }], fetch: fakeFetch(['{"answer":"four"}', '```json\n{"answer":4}\n```'], seen) });
    expect(data.answer).toBe(4);
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[1]!.messages)).toContain('invalid');
    expect((seen[0]!.response_format as { type: string }).type).toBe('json_schema');
  });
  it('fails after one retry', async () => {
    await expect(chatJSON(S, { env, purpose: 'p', messages: [], fetch: fakeFetch(['nope']) })).rejects.toThrow(/failed validation/);
  });
});

describe('helpers', () => {
  it('limiter caps concurrency', async () => {
    const run = createLimiter(2);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => run(async () => { peak = Math.max(peak, ++active); await new Promise((r) => setTimeout(r, 5)); active--; })));
    expect(peak).toBe(2);
  });
  it('cosine of vectors with different lengths is 0, never a partial dot product (256-dim rows beside 4096-dim ones)', () => {
    expect(cosine([1, 0, 0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 2], [1, 2])).toBeCloseTo(1);
  });

  it('ranks by cosine and prices cached tokens lower', () => {
    const ranked = rankByCosine([1, 0], [{ item: 'a', embedding: [0, 1] }, { item: 'b', embedding: [1, 0.1] }], 1);
    expect(ranked[0]!.item).toBe('b');
    expect(costUsd('nvidia/Nemotron-3-Ultra-550b-a55b', 1000, 100, 800)).toBeLessThan(costUsd('nvidia/Nemotron-3-Ultra-550b-a55b', 1000, 100, 0));
    expect(stripThinking('<think>hmm</think>answer')).toBe('answer');
  });
});
