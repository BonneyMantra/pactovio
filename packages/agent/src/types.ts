import type { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';

export type ActionSource = 'chat' | 'event' | 'mcp' | 'digest';

export interface AgentToolCtx {
  workspaceId: string;
  /** Judge/app session (null for API-key callers such as MCP). */
  sessionId?: string | null;
  threadId?: string;
  source?: ActionSource;
  /**
   * Set ONLY by the confirmation path (AgentHub.decide) after a human confirmed the pending action.
   * `invokeTool` never executes a confirmation-required tool without it.
   */
  confirmed?: boolean;
}

export interface ToolCard {
  title: string;
  detail: string;
}

export interface AgentTool<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  /** true if the tool changes state or contacts a third party: it returns a pending action instead of executing. */
  mutating?: boolean;
  /** Overrides `mutating` per call (e.g. buyer_intel only needs confirmation when it refreshes via Tavily). */
  needsConfirmation?(input: z.infer<I>): boolean;
  /** Human-readable confirmation card, resolved against live data (tender titles etc). */
  describe?(env: Env, ctx: AgentToolCtx, input: z.infer<I>): Promise<ToolCard>;
  run(env: Env, ctx: AgentToolCtx, input: z.infer<I>): Promise<unknown>;
}

export type ToolOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'pending'; tool: string; input: Record<string, unknown>; title: string; detail: string; summary: string }
  | { status: 'error'; error: string; code: string };

/** Per-judge-session caps (BUILD-BRIEF section 4). */
export const AGENT_CAPS = {
  turnsPerMinute: 10,
  /** Per-session model-token budget for chat turns (input + output). */
  sessionTokenBudget: 150_000,
  maxToolSteps: 6,
} as const;

/** Infers `I` so `run`/`describe`/`needsConfirmation` get the tool's parsed input type. */
export const defineTool = <I extends z.ZodType>(t: AgentTool<I>): AgentTool => t as unknown as AgentTool;
