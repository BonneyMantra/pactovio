import type { ModelEnv } from '@pactovio/contracts/env';
import { DEFAULT_MODELS, isModelUnavailable } from '@pactovio/models';

export { isModelUnavailable };

/** Vision-capable models on Token Factory, tried in order when the configured one is not served (it can be withdrawn). */
export const VISION_FALLBACKS = ['google/gemma-3-27b-it', 'openbmb/MiniCPM-V-4_5'] as const;

export function visionModels(env: ModelEnv): string[] {
  const list = [env.MODEL_AGENT || DEFAULT_MODELS.agent, ...VISION_FALLBACKS];
  return [...new Set(list)];
}

/** Run `call(model)` against each vision model until one is served. Rethrows the last error. */
export async function withVisionModel<T>(env: ModelEnv, call: (model: string) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const m of visionModels(env)) {
    try {
      return await call(m);
    } catch (e) {
      last = e;
      if (!isModelUnavailable(e)) throw e;
    }
  }
  throw last;
}
