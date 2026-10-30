import { HttpError, newId, type PlanId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { sendUsage } from './dodo';
import { planCredits } from './plans';

export interface PlanState { plan: PlanId; status: string; currentPeriodEnd: string | null; creditsBalance: number }

const month = () => new Date().toISOString().slice(0, 7);
const now = () => new Date().toISOString();

async function workspaceInfo(env: Env, ws: string) {
  const r = await env.DB.prepare(
    'SELECT w.sample AS sample, s.plan AS plan, s.status AS status, s.current_period_end AS cpe, s.dodo_customer_id AS cust FROM workspaces w LEFT JOIN subscriptions s ON s.workspace_id = w.id WHERE w.id = ?',
  ).bind(ws).first<{ sample: number; plan: PlanId | null; status: string | null; cpe: string | null; cust: string | null }>();
  if (!r) throw new HttpError(404, 'Workspace not found', 'not_found');
  return { sample: r.sample === 1, plan: (r.plan ?? 'free') as PlanId, status: r.status ?? 'active', cpe: r.cpe, cust: r.cust };
}

export async function balance(env: Env, ws: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE workspace_id = ?').bind(ws).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Idempotent credit grant. `externalId` (webhook-id) or `ref` dedupes. Returns true when a row was written. */
export async function grantCredits(env: Env, ws: string, credits: number, reason: string, opts: { ref?: string; externalId?: string }): Promise<boolean> {
  const res = await env.DB.prepare('INSERT OR IGNORE INTO credit_ledger (id, workspace_id, delta, reason, ref, external_event_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('ledger'), ws, credits, reason, opts.ref ?? null, opts.externalId ?? null, now()).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Plan and balance. Free-plan real workspaces get a lazy monthly Scout grant (3 credits = 3 small pack reads). */
export async function getPlan(env: Env, workspaceId: string): Promise<PlanState> {
  const w = await workspaceInfo(env, workspaceId);
  if (w.plan === 'free' && !w.sample) await grantCredits(env, workspaceId, planCredits('free'), 'scout_monthly_grant', { ref: `scout:${month()}` });
  return { plan: w.plan, status: w.status, currentPeriodEnd: w.cpe, creditsBalance: await balance(env, workspaceId) };
}

/**
 * Spend credits (negative ledger row), idempotent by `ref` (a retried step never double-charges).
 * Sample workspaces are shared by every judge: they are never charged (session caps apply instead).
 * Throws 402 `insufficient_credits` when the balance is too low. Returns the new balance.
 */
export async function chargeCredits(env: Env, workspaceId: string, credits: number, reason: string, ref: string): Promise<number> {
  if (!Number.isInteger(credits) || credits <= 0) throw new HttpError(400, 'credits must be a positive integer', 'validation');
  const w = await workspaceInfo(env, workspaceId);
  if (w.sample) return balance(env, workspaceId);
  if (w.plan === 'free') await grantCredits(env, workspaceId, planCredits('free'), 'scout_monthly_grant', { ref: `scout:${month()}` });
  const dup = await env.DB.prepare('SELECT 1 AS x FROM credit_ledger WHERE workspace_id = ? AND ref = ?').bind(workspaceId, ref).first();
  if (dup) return balance(env, workspaceId);
  // Atomic: the row is only inserted while the balance covers it.
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger (id, workspace_id, delta, reason, ref, external_event_id, at)
     SELECT ?1, ?2, ?3, ?4, ?5, NULL, ?6 WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE workspace_id = ?2) >= ?7`,
  ).bind(newId('ledger'), workspaceId, -credits, reason, ref, now(), credits).run();
  if ((res.meta.changes ?? 0) === 0) {
    const again = await env.DB.prepare('SELECT 1 AS x FROM credit_ledger WHERE workspace_id = ? AND ref = ?').bind(workspaceId, ref).first();
    if (!again) throw new HttpError(402, `Not enough credits (need ${credits})`, 'insufficient_credits');
  } else {
    await sendUsage(env, w.cust, `${workspaceId}:${ref}`, credits, reason);
  }
  return balance(env, workspaceId);
}
