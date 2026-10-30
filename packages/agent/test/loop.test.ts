import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { streamToolLoop, type ToolRunResult } from '../src';

const enc = new TextEncoder();
const sse = (chunks: unknown[]) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const delta = (d: object, usage?: object) => ({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d }], ...(usage ? { usage } : {}) });
const text = (...parts: string[]) => sse([...parts.map((p) => delta({ content: p })), delta({}, { prompt_tokens: 100, completion_tokens: 20 })]);
const toolCall = (name: string, args: unknown, id = 'call_1') =>
  sse([
    delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(0, 8) } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(8) } }] }),
    delta({}, { prompt_tokens: 150, completion_tokens: 30 }),
  ]);

const env = { NEBIUS_API_KEY: 'test-key', MODEL_AGENT: 'agent-model', MODEL_REASON: 'reason-model' } as unknown as Env;
const tools = [{ name: 'get_tender', description: 'Get a tender', input: z.object({ tender_id: z.string() }) }];
const base = { env, tools, messages: [{ role: 'user' as const, content: 'hi' }] };
const models = (calls: { model: string }[]) => calls.map((c) => c.model);

function scripted(responses: (() => Response)[], seen: { model: string; body: Record<string, unknown> }[] = []) {
  let i = 0;
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ model: String(body.model), body });
    return responses[Math.min(i++, responses.length - 1)]!();
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('streamToolLoop', () => {
  it('streams tokens as deltas and returns the text with usage', async () => {
    const { f, seen } = scripted([() => text('Two ', 'matches ', 'today.')]);
    const deltas: string[] = [];
    const r = await streamToolLoop({ ...base, fetch: f, onDelta: (d) => deltas.push(d), runTool: vi.fn() });
    expect(deltas).toEqual(['Two ', 'matches ', 'today.']);
    expect(r.text).toBe('Two matches today.');
    expect(r.tokensIn).toBe(100);
    expect(r.modelCalls).toBe(1);
    expect(seen[0]!.body.stream).toBe(true);
    expect(models(seen)).toEqual(['agent-model']);
  });

  it('assembles streamed tool-call arguments, runs the tool, feeds the result back, then answers', async () => {
    const { f, seen } = scripted([() => toolCall('get_tender', { tender_id: 'tnd_1' }), () => text('Teagasc closes 19 Nov.')]);
    const runTool = vi.fn(async (): Promise<ToolRunResult> => ({ status: 'ok', output: { title: 'T' }, content: '{"title":"T"}' }));
    const events: string[] = [];
    const r = await streamToolLoop({ ...base, fetch: f, runTool, onToolCall: (c) => events.push(`${c.name}:${c.status}`) });
    expect(runTool).toHaveBeenCalledWith({ id: 'call_1', name: 'get_tender', input: { tender_id: 'tnd_1' } });
    expect(events).toEqual(['get_tender:running', 'get_tender:ok']);
    expect(r.text).toBe('Teagasc closes 19 Nov.');
    const second = seen[1]!.body.messages as { role: string; content?: string; tool_call_id?: string }[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '{"title":"T"}' });
  });

  it('a pending-confirmation tool result is passed to the model as such and reported to the host', async () => {
    const { f } = scripted([() => toolCall('get_tender', { tender_id: 'tnd_1' }), () => text('I asked you to confirm.')]);
    const statuses: string[] = [];
    await streamToolLoop({
      ...base, fetch: f, onToolCall: (c) => statuses.push(c.status),
      runTool: async () => ({ status: 'pending_confirmation', output: { action_id: 'act_1' }, content: '{"status":"pending_confirmation"}' }),
    });
    expect(statuses).toEqual(['running', 'pending_confirmation']);
  });

  it('falls back to MODEL_REASON after two failures of the agent model', async () => {
    const seen: { model: string; body: Record<string, unknown> }[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push({ model: String(body.model), body });
      if (body.model === 'agent-model') return new Response(JSON.stringify({ error: { message: 'tool calling unsupported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return text('Answered by the reasoning model.');
    }) as unknown as typeof fetch;
    const r = await streamToolLoop({ ...base, fetch: f, runTool: vi.fn() });
    expect(r.fellBack).toBe(true);
    expect(r.text).toBe('Answered by the reasoning model.');
    expect(models(seen)).toEqual(['agent-model', 'agent-model', 'reason-model']);
  });

  it('a 404 for the agent model (withdrawn) moves to the text fallback at once, then to MODEL_REASON if that is gone too', async () => {
    const seen: { model: string; body: Record<string, unknown> }[] = [];
    const gone = () => new Response(JSON.stringify({ error: { message: 'The model does not exist' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    const f = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push({ model: String(body.model), body });
      return body.model === 'agent-model' ? gone() : text('Answered by the text fallback.');
    }) as unknown as typeof fetch;
    const r = await streamToolLoop({ ...base, fetch: f, runTool: vi.fn() });
    expect(models(seen)).toEqual(['agent-model', 'nvidia/nemotron-3-super-120b-a12b']);
    expect(r.fellBack).toBe(true);
    expect(r.text).toBe('Answered by the text fallback.');
    expect(seen[1]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    const seen2: string[] = [];
    const f2 = (async (_u: string, init: RequestInit) => {
      const m = String((JSON.parse(String(init.body)) as { model: string }).model);
      seen2.push(m);
      return m === 'reason-model' ? text('Reasoning answered.') : gone();
    }) as unknown as typeof fetch;
    const r2 = await streamToolLoop({ ...base, fetch: f2, runTool: vi.fn() });
    expect(seen2).toEqual(['agent-model', 'nvidia/nemotron-3-super-120b-a12b', 'reason-model']);
    expect(r2.text).toBe('Reasoning answered.');
  });

  it('malformed tool arguments count as failures and trigger the same fallback', async () => {
    const bad = () => sse([delta({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'get_tender', arguments: '{"tender_id": ' } }] }), delta({}, { prompt_tokens: 5, completion_tokens: 5 })]);
    const seen: { model: string; body: Record<string, unknown> }[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push({ model: String(body.model), body });
      return body.model === 'agent-model' ? bad() : text('ok');
    }) as unknown as typeof fetch;
    const runTool = vi.fn();
    const r = await streamToolLoop({ ...base, fetch: f, runTool });
    expect(runTool).not.toHaveBeenCalled();
    expect(r.fellBack).toBe(true);
  });

  it('an unknown tool name from the model is never executed', async () => {
    const { f } = scripted([() => toolCall('drop_database', {}), () => toolCall('drop_database', {}), () => text('fine')]);
    const runTool = vi.fn();
    await streamToolLoop({ ...base, fetch: f, runTool });
    expect(runTool).not.toHaveBeenCalled();
  });

  it('stops after the step cap instead of looping forever', async () => {
    const { f } = scripted([() => toolCall('get_tender', { tender_id: 'tnd_1' })]);
    const runTool = async (): Promise<ToolRunResult> => ({ status: 'ok', output: {}, content: '{}' });
    const r = await streamToolLoop({ ...base, fetch: f, runTool, maxSteps: 3 });
    expect(r.stoppedEarly).toBe(true);
    expect(r.modelCalls).toBe(3);
  });

  it('hides reasoning inside <think> tags from the stream', async () => {
    const { f } = scripted([() => text('<think>I should call', ' a tool</think>', 'Answer.')]);
    const deltas: string[] = [];
    const r = await streamToolLoop({ ...base, fetch: f, onDelta: (d) => deltas.push(d), runTool: vi.fn() });
    expect(deltas.join('')).toBe('Answer.');
    expect(r.text).toBe('Answer.');
  });
});
