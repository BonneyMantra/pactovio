import type OpenAI from 'openai';
import { client, modelFor } from './client';
import { costUsd } from './prices';
import { flexLimiter, liveLimiter } from './limiter';
import type { CallOptions, ChatMessage, ChatResult } from './types';

type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatParams extends CallOptions {
  messages: ChatMessage[];
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | 'required';
  /** Extra request body fields (e.g. response_format). */
  extra?: Record<string, unknown>;
}

/**
 * One chat completion with limiter, thinking-off for fast, flex tier, and run_step logging.
 * Put the pack text FIRST in `messages` so later calls of a run reuse the prompt cache.
 */
export async function chat(p: ChatParams): Promise<ChatResult> {
  const role = p.role ?? 'reason';
  const model = modelFor(p.env, role, p.model);
  const limit = p.flex ? flexLimiter : liveLimiter;
  const body: Record<string, unknown> = {
    model,
    messages: p.messages,
    ...(p.maxTokens ? { max_tokens: p.maxTokens } : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.tools?.length ? { tools: p.tools, tool_choice: p.toolChoice ?? 'auto' } : {}),
    ...(p.flex ? { service_tier: 'flex' } : {}),
    // MODEL_FAST is a thinking model: it must never think.
    ...(role === 'fast' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...p.extra,
  };
  const t0 = Date.now();
  try {
    const res = await limit(() => client(p).chat.completions.create(body as never, { signal: p.signal })) as OpenAI.Chat.Completions.ChatCompletion;
    const ms = Date.now() - t0;
    const msg = res.choices[0]?.message;
    const usage = res.usage as (OpenAI.CompletionUsage & { prompt_tokens_details?: { cached_tokens?: number } }) | undefined;
    const tokensIn = usage?.prompt_tokens ?? 0;
    const tokensOut = usage?.completion_tokens ?? 0;
    const tokensCached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cost = costUsd(model, tokensIn, tokensOut, tokensCached, !!p.flex);
    await p.onStep?.({ purpose: p.purpose, model, status: 'ok', tokensIn, tokensOut, tokensCached, ms, costUsd: cost });
    return {
      text: stripThinking(msg?.content ?? ''),
      model, tokensIn, tokensOut, tokensCached, ms, costUsd: cost,
      toolCalls: (msg?.tool_calls ?? []).flatMap((t) => (t.type === 'function' ? [{ id: t.id, name: t.function.name, arguments: t.function.arguments }] : [])),
      raw: res,
    };
  } catch (err) {
    await p.onStep?.({ purpose: p.purpose, model, status: 'error', tokensIn: 0, tokensOut: 0, tokensCached: 0, ms: Date.now() - t0, costUsd: 0, summary: err instanceof Error ? err.message.slice(0, 300) : 'error' });
    throw err;
  }
}

/** Remove `<think>...</think>` blocks that reasoning models may leak into content. */
export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
