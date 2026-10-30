import { AGENT_CAPS } from './types';

export interface CapResult { ok: boolean; retryAfterSec: number; used: number }

/** Sliding window: `stamps` are ms timestamps of this session's recent turns. */
export function checkTurnCap(stamps: number[], now: number, cap: number = AGENT_CAPS.turnsPerMinute, windowMs = 60_000): CapResult {
  const recent = stamps.filter((t) => now - t < windowMs).sort((a, b) => a - b);
  if (recent.length < cap) return { ok: true, retryAfterSec: 0, used: recent.length };
  const oldest = recent[recent.length - cap]!;
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)), used: recent.length };
}

export function checkTokenBudget(used: number, budget: number = AGENT_CAPS.sessionTokenBudget): { ok: boolean; remaining: number } {
  return { ok: used < budget, remaining: Math.max(0, budget - used) };
}
