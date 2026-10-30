import { z } from 'zod';
import type OpenAI from 'openai';
import { chat, type ChatParams } from './chat';
import { modelFor } from './client';
import type { ChatMessage, ChatResult } from './types';

export interface LoopTool {
  name: string;
  description: string;
  input: z.ZodType;
  run(input: unknown): Promise<unknown>;
}

export interface ToolLoopResult {
  text: string;
  messages: ChatMessage[];
  steps: ChatResult[];
  /** true if MODEL_AGENT failed twice on tool calling and MODEL_REASON answered instead. */
  fellBack: boolean;
}

/**
 * Agent tool loop skeleton (MODEL_AGENT). If tool calling errors twice in a run, falls back to MODEL_REASON.
 * The agent lane adds approval gating, streaming, and the system prompt.
 */
export async function toolLoop(p: Omit<ChatParams, 'tools'> & { tools: LoopTool[]; maxSteps?: number }): Promise<ToolLoopResult> {
  const specs: OpenAI.Chat.Completions.ChatCompletionTool[] = p.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.input, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown> },
  }));
  const messages = [...p.messages];
  const steps: ChatResult[] = [];
  let failures = 0;
  let fellBack = false;
  let role = p.role ?? 'agent';
  for (let i = 0; i < (p.maxSteps ?? 8); i++) {
    let res: ChatResult;
    try {
      res = await chat({ ...p, role, model: role === 'reason' ? modelFor(p.env, 'reason') : p.model, messages, tools: specs });
    } catch (e) {
      if (++failures >= 2 && role !== 'reason') { role = 'reason'; fellBack = true; continue; }
      if (failures >= 2) throw e;
      continue;
    }
    steps.push(res);
    if (!res.toolCalls.length) return { text: res.text, messages, steps, fellBack };
    messages.push({ role: 'assistant', content: res.text || null, tool_calls: res.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) });
    for (const call of res.toolCalls) {
      const tool = p.tools.find((t) => t.name === call.name);
      let out: unknown;
      try {
        out = tool ? await tool.run(tool.input.parse(JSON.parse(call.arguments || '{}'))) : { error: `unknown tool ${call.name}` };
      } catch (e) {
        out = { error: e instanceof Error ? e.message : 'tool failed' };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) });
    }
  }
  return { text: '', messages, steps, fellBack };
}
