import { z } from 'zod';
import { HttpError, NotImplemented } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { agentTools } from './tools';
import { ToolError } from './tools/db';
import type { AgentTool, AgentToolCtx, ToolOutcome } from './types';

export const getTool = (name: string): AgentTool | undefined => agentTools.find((t) => t.name === name);

export const requiresConfirmation = (tool: AgentTool, input: unknown): boolean =>
  tool.needsConfirmation ? tool.needsConfirmation(input as never) : !!tool.mutating;

export const toolJsonSchema = (tool: AgentTool): Record<string, unknown> =>
  z.toJSONSchema(tool.input, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;

function failure(e: unknown): ToolOutcome {
  if (e instanceof z.ZodError) return { status: 'error', code: 'validation', error: e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  if (e instanceof ToolError) return { status: 'error', code: e.code, error: e.message };
  if (e instanceof NotImplemented) return { status: 'error', code: 'not_available_yet', error: `${e.message}. That part of Pactovio is still being built.` };
  if (e instanceof HttpError) return { status: 'error', code: e.code ?? 'error', error: e.message };
  console.error('agent tool failed', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');
  return { status: 'error', code: 'internal', error: 'The tool failed unexpectedly.' };
}

/**
 * The only way chat and MCP run a tool. Validates input with the tool's zod schema; if the tool needs confirmation
 * and `ctx.confirmed` is not set it does NOT run: it returns a pending-action description for the host to store.
 */
export async function invokeTool(env: Env, ctx: AgentToolCtx, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const tool = getTool(name);
  if (!tool) return { status: 'error', code: 'unknown_tool', error: `Unknown tool ${name}` };
  let input: unknown;
  try {
    input = tool.input.parse(rawInput ?? {});
  } catch (e) {
    return failure(e);
  }
  try {
    if (requiresConfirmation(tool, input) && !ctx.confirmed) {
      const card = tool.describe ? await tool.describe(env, ctx, input as never).catch(() => null) : null;
      const title = card?.title ?? `Run ${name}?`;
      const detail = card?.detail ?? JSON.stringify(input).slice(0, 240);
      return { status: 'pending', tool: name, input: (input ?? {}) as Record<string, unknown>, title, detail, summary: `${title} ${detail}`.trim() };
    }
    return { status: 'ok', result: await tool.run(env, ctx, input as never) };
  } catch (e) {
    return failure(e);
  }
}
