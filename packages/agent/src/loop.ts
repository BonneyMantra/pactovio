import { costUsd, isModelUnavailable, makeClient, modelFor, stripThinking, TEXT_FALLBACK_MODEL, type ChatMessage } from '@pactovio/models';
import type { Env } from '@pactovio/contracts/env';
import { toolJsonSchema } from './gate';
import { AGENT_CAPS, type AgentTool } from './types';

export interface ToolRunResult {
  /** String fed back to the model as the tool message (compact JSON). */
  content: string;
  status: 'ok' | 'error' | 'pending_confirmation';
  output: unknown;
}

export interface StreamLoopParams {
  env: Env;
  messages: ChatMessage[];
  tools: Pick<AgentTool, 'name' | 'description' | 'input'>[];
  runTool(call: { id: string; name: string; input: unknown }): Promise<ToolRunResult>;
  onDelta?(text: string): void;
  onToolCall?(c: { id: string; name: string; input: unknown; status: 'running' | 'ok' | 'error' | 'pending_confirmation'; output?: unknown }): void;
  maxSteps?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Test seam. */
  fetch?: typeof fetch;
}

export interface StreamLoopResult {
  text: string;
  messages: ChatMessage[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  modelCalls: number;
  fellBack: boolean;
  model: string;
  stoppedEarly: boolean;
}

/** Hides `<think>...</think>` spans from a token stream, even when a tag is split across chunks. */
export class ThinkFilter {
  private buf = '';
  private inside = false;
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf('</think>');
        if (end === -1) { this.buf = this.buf.slice(Math.max(0, this.buf.length - 7)); return out; }
        this.buf = this.buf.slice(end + 8);
        this.inside = false;
      } else {
        const start = this.buf.indexOf('<think>');
        if (start === -1) {
          const keep = partialTagLen(this.buf);
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inside = true;
      }
    }
  }
  flush(): string {
    const rest = this.inside ? '' : this.buf;
    this.buf = '';
    return rest;
  }
}
function partialTagLen(s: string): number {
  for (let n = Math.min(6, s.length); n > 0; n--) if ('<think>'.startsWith(s.slice(s.length - n))) return n;
  return 0;
}

interface StepOut {
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  tokensIn: number;
  tokensOut: number;
}

async function streamStep(p: StreamLoopParams, model: string, messages: ChatMessage[], specs: unknown[], thinking: boolean): Promise<StepOut> {
  const client = makeClient(p.env, p.fetch);
  const stream = (await client.chat.completions.create(
    {
      model, messages, tools: specs, tool_choice: 'auto', stream: true, stream_options: { include_usage: true },
      ...(p.maxTokens ? { max_tokens: p.maxTokens } : {}),
      // A chat must answer in seconds: the agent model runs with thinking off; the Ultra fallback keeps it on.
      ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    } as never,
    { signal: p.signal },
  )) as unknown as AsyncIterable<{
    choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;
  const filter = new ThinkFilter();
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const chunk of stream) {
    if (chunk.usage) { tokensIn = chunk.usage.prompt_tokens ?? tokensIn; tokensOut = chunk.usage.completion_tokens ?? tokensOut; }
    const d = chunk.choices?.[0]?.delta;
    if (!d) continue;
    if (d.content) {
      const visible = filter.push(d.content);
      if (visible) { text += visible; p.onDelta?.(visible); }
    }
    for (const tc of d.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  const tail = filter.flush();
  if (tail) { text += tail; p.onDelta?.(tail); }
  if (!tokensIn && !tokensOut) {
    tokensIn = Math.ceil(JSON.stringify(messages).length / 4);
    tokensOut = Math.ceil((text.length + [...calls.values()].reduce((a, c) => a + c.arguments.length, 0)) / 4);
  }
  return { text: stripThinking(text), calls: [...calls.values()].filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` })), tokensIn, tokensOut };
}

/**
 * Streaming tool loop on MODEL_AGENT (Nemotron 3.5 Super VL). Same fallback contract as @pactovio/models toolLoop:
 * after two failures (request errors or malformed tool calls) the run continues on MODEL_REASON (Ultra).
 * `runTool` is where confirmation gating happens; a pending tool result tells the model to wait.
 */
export async function streamToolLoop(p: StreamLoopParams): Promise<StreamLoopResult> {
  const specs = p.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolJsonSchema(t as AgentTool) } }));
  const messages = [...p.messages];
  // agent model -> (404 only) text fallback -> reason model. Two other failures skip straight to the reason model.
  let role = 'agent' as 'agent' | 'text' | 'reason';
  let failures = 0;
  let fellBack = false;
  let tokensIn = 0, tokensOut = 0, cost = 0, modelCalls = 0;
  let model = modelFor(p.env, 'agent');
  const maxSteps = p.maxSteps ?? AGENT_CAPS.maxToolSteps;
  let steps = 0;
  const fail = (): void => {
    failures++;
    if (failures >= 2 && role !== 'reason') { role = 'reason'; fellBack = true; failures = 0; }
  };
  let guard = 0;
  while (steps < maxSteps && guard++ < maxSteps + 6) {
    model = role === 'text' ? TEXT_FALLBACK_MODEL : modelFor(p.env, role);
    let out: StepOut;
    try {
      modelCalls++;
      out = await streamStep(p, model, messages, specs, role === 'reason');
    } catch (e) {
      if (role === 'reason' && failures >= 1) throw e;
      if (role === 'reason') { failures++; continue; }
      if (isModelUnavailable(e)) { role = role === 'agent' ? 'text' : 'reason'; fellBack = true; failures = 0; continue; }
      fail();
      continue;
    }
    tokensIn += out.tokensIn; tokensOut += out.tokensOut;
    cost += costUsd(model, out.tokensIn, out.tokensOut, 0, false);
    if (!out.calls.length) {
      messages.push({ role: 'assistant', content: out.text });
      return { text: out.text, messages, tokensIn, tokensOut, costUsd: cost, modelCalls, fellBack, model, stoppedEarly: false };
    }
    const parsed = out.calls.map((c) => {
      try { return { ...c, input: JSON.parse(c.arguments || '{}') as unknown, bad: false }; } catch { return { ...c, input: {} as unknown, bad: true }; }
    });
    if (parsed.some((c) => c.bad || !p.tools.some((t) => t.name === c.name))) { fail(); continue; }
    steps++;
    messages.push({ role: 'assistant', content: out.text || null, tool_calls: out.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
    for (const c of parsed) {
      p.onToolCall?.({ id: c.id, name: c.name, input: c.input, status: 'running' });
      let res: ToolRunResult;
      try {
        res = await p.runTool({ id: c.id, name: c.name, input: c.input });
      } catch (e) {
        res = { status: 'error', output: { error: e instanceof Error ? e.message : 'tool failed' }, content: JSON.stringify({ error: 'tool failed' }) };
      }
      p.onToolCall?.({ id: c.id, name: c.name, input: c.input, status: res.status, output: res.output });
      messages.push({ role: 'tool', tool_call_id: c.id, content: res.content });
    }
  }
  const text = 'I stopped before finishing: that took more tool steps than I allow in one turn. Ask me to continue, or narrow the question.';
  messages.push({ role: 'assistant', content: text });
  return { text, messages, tokensIn, tokensOut, costUsd: cost, modelCalls, fellBack, model, stoppedEarly: true };
}

