import type { AiState } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { isBudgetError, modelsDisabled } from '@pactovio/models';

/** Model-backed onboarding steps always return their code-only result; this says honestly why AI did not run. */
export async function aiPrecheck(env: Env): Promise<AiState | null> {
  if (await modelsDisabled(env)) return { ran: false, code: 'models_disabled' };
  if (!env.NEBIUS_API_KEY) return { ran: false, code: 'unavailable' };
  return null;
}

/** Same classification as integration-normalize: kill switch, daily cap, upstream 401/403, anything else. */
export function aiFailure(error: unknown): AiState {
  if (isBudgetError(error)) {
    const code = (error as { code?: string; error?: { code?: string } }).code ?? (error as { error?: { code?: string } }).error?.code;
    return { ran: false, code: code === 'models_off' ? 'models_disabled' : 'budget' };
  }
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return { ran: false, code: 'auth_rejected' };
  return { ran: false, code: 'unavailable' };
}
