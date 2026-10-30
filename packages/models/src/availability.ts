/** Text model served when MODEL_AGENT (Nemotron 3.5 Super VL) is withdrawn or returns 404 'does not exist'. */
export const TEXT_FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

/** The model endpoint rejected the model id itself (withdrawn or renamed), as opposed to a bad request. */
export function isModelUnavailable(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return err?.status === 404 || /does not exist|model.*not found|unknown model/i.test(err?.message ?? '');
}
