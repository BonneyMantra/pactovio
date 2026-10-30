import type { ModelEnv } from '@pactovio/contracts/env';

export type ModelRole = 'reason' | 'agent' | 'fast' | 'embed';

export interface StepRecord {
  purpose: string;
  model: string;
  status: 'ok' | 'error';
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  ms: number;
  costUsd: number;
  summary?: string;
}
/** Called after every model call; engine wires this to a run_steps insert + `run.step` event. */
export type StepLogger = (step: StepRecord) => void | Promise<void>;

export interface CallOptions {
  env: ModelEnv;
  /** run_steps label, e.g. "extract requirements". */
  purpose: string;
  role?: ModelRole;
  /** Override the model id (otherwise from role/env). */
  model?: string;
  /** Nightly/bulk calls: service_tier flex, concurrency cap 4. */
  flex?: boolean;
  onStep?: StepLogger;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Per-request timeout in ms (default 120 s). Whole-pack calls with 100k+ token prompts need longer. */
  timeoutMs?: number;
  /** Test seam: replace the HTTP client. */
  fetch?: typeof fetch;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

export interface ChatResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  ms: number;
  costUsd: number;
  toolCalls: { id: string; name: string; arguments: string }[];
  raw: unknown;
}
