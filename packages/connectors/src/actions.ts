import type { Composio } from './composio';

export type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ActionOutput {
  /** Provider's id for what was created (issue key, message ts, event id...). */
  id: string | null;
  /** Human link to the created object when the provider returns one. */
  url?: string | null;
  /** Provider-specific extras the readback/cleanup steps need. */
  details?: Record<string, unknown>;
}

/** Everything an action may touch. Tests pass a fake `exec`; production wires Composio. */
export interface ActionCtx {
  workspaceId: string;
  provider: string;
  /** connectors.meta_json (rules excluded is not required; actions read `meta.config`). */
  meta: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  account: { id: string; userId: string };
  composio: Composio;
  /** Run one Composio tool as the connected account; throws ActionError when the tool reports failure. */
  exec(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Authenticated raw provider call through Composio's proxy. */
  proxy(req: { endpoint: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  /** Merge into connectors.meta_json.config (remembered folder id, project key, ...). */
  saveConfig(patch: Record<string, unknown>): Promise<void>;
  /** Stage bytes for a `file_uploadable` tool input. */
  stage(tool: string, f: { filename: string; mimetype: string; bytes: Uint8Array }): Promise<{ name: string; mimetype: string; s3key: string }>;
  /** Resolved before run() when the input carries `r2_key`. */
  file?: { filename: string; mimetype: string; bytes: Uint8Array };
  now(): Date;
}

export interface ActionDef {
  summary: string;
  run(input: Input, ctx: ActionCtx): Promise<ActionOutput>;
  /** e2e: read the created object back through Composio and confirm it exists. */
  readback?(out: ActionOutput, ctx: ActionCtx): Promise<boolean>;
  /** e2e: remove what the action created, where the provider allows. */
  cleanup?(out: ActionOutput, ctx: ActionCtx): Promise<void>;
  /** e2e: a safe input for a live test. */
  sample?(ctx: { email: string | null }): Input;
}

export class ActionError extends Error {
  constructor(message: string, public code: 'tool_failed' | 'bad_input' | 'not_configured' | 'unsupported' = 'tool_failed') {
    super(message);
    this.name = 'ActionError';
  }
}

export function need<T>(v: T | null | undefined | '', what: string): T {
  if (v === null || v === undefined || v === '') throw new ActionError(`${what} is required`, 'bad_input');
  return v as T;
}

export type ProviderActions = Record<string, ActionDef>;
