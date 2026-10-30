import OpenAI from 'openai';
import type { ModelEnv } from '@pactovio/contracts/env';
import type { CallOptions, ModelRole } from './types';

export const DEFAULT_BASE = 'https://api.tokenfactory.nebius.com/v1/';
export const DEFAULT_MODELS: Record<ModelRole, string> = {
  reason: 'nvidia/Nemotron-3-Ultra-550b-a55b',
  agent: 'nvidia/Nemotron-3.5-Super-VL',
  fast: 'nvidia/Nemotron-3_5-Lightning',
  embed: 'Qwen/Qwen3-Embedding-8B',
};

export function modelFor(env: ModelEnv, role: ModelRole, override?: string): string {
  if (override) return override;
  const fromEnv = { reason: env.MODEL_REASON, agent: env.MODEL_AGENT, fast: env.MODEL_FAST, embed: env.MODEL_EMBED }[role];
  return fromEnv || DEFAULT_MODELS[role];
}

/** OpenAI SDK pointed at Nebius Token Factory. */
export function makeClient(env: ModelEnv, fetchImpl?: typeof fetch, timeoutMs?: number): OpenAI {
  if (!env.NEBIUS_API_KEY) throw new Error('NEBIUS_API_KEY is not configured');
  return new OpenAI({
    apiKey: env.NEBIUS_API_KEY,
    baseURL: env.TOKEN_FACTORY_BASE_URL || DEFAULT_BASE,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    maxRetries: timeoutMs ? 1 : 2,
    timeout: timeoutMs ?? 120_000,
  });
}

export const client = (o: Pick<CallOptions, 'env' | 'fetch' | 'timeoutMs'>) => makeClient(o.env, o.fetch, o.timeoutMs);
