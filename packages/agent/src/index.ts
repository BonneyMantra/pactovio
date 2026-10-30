import type { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';

export interface AgentToolCtx {
  workspaceId: string;
  sessionId?: string;
  threadId?: string;
  /** Tools with side effects must call this and return; the action runs only after the user confirms. */
  requestApproval?: (summary: string, input: Record<string, unknown>) => Promise<{ approved: boolean }>;
}

export interface AgentTool<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  /** true if the tool changes state or contacts a third party: AgentHub asks the user first, MCP exposes it with a confirmation hint. */
  mutating?: boolean;
  run(env: Env, ctx: AgentToolCtx, input: z.infer<I>): Promise<unknown>;
}

/** Shared by AgentHub chat and the MCP server. Lane: agent fills this in. */
export const agentTools: AgentTool[] = [];
