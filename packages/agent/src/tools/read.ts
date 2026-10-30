import { z } from 'zod';
import { NotImplemented } from '@pactovio/contracts';
import { buyerIntel } from '@pactovio/engine';
import { getPlan } from '@pactovio/billing';
import { clip, daysUntil } from '../format';
import { AGENT_CAPS, defineTool, type AgentTool } from '../types';
import { one, requireTender, rows, ToolError } from './db';

const limit = (max: number, def: number) => z.number().int().min(1).max(max).default(def);
const tenderId = z.string().min(3).describe('Tender id, e.g. tnd_sample_teagasc_p4941');

export const listToday = defineTool({
  name: 'list_today',
  description: "Today's feed for the workspace: counts, the best-fit matches, deadlines closing soon, open intakes, answers awaiting approval and expiring certificates.",
  input: z.object({}),
  async run(env, ctx) {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const w = ctx.workspaceId;
    const matches = await rows<{ tender_id: string; title: string; buyer: string; fit_score: number; deadline: string | null; status: string }>(
      env, `SELECT t.id AS tender_id, t.title, t.buyer, m.fit_score, t.deadline, m.status FROM tender_matches m JOIN tenders t ON t.id = m.tender_id
            WHERE m.workspace_id = ? AND m.status != 'dismissed' ORDER BY m.fit_score DESC LIMIT 5`, w);
    const closing = await rows<{ tender_id: string; title: string; deadline: string }>(
      env, `SELECT t.id AS tender_id, t.title, t.deadline FROM tenders t JOIN tender_matches m ON m.tender_id = t.id
            WHERE m.workspace_id = ? AND m.status != 'dismissed' AND t.deadline > ? ORDER BY t.deadline LIMIT 5`, w, iso);
    const n = async (sql: string, ...b: unknown[]) => (await one<{ n: number }>(env, sql, ...b))?.n ?? 0;
    const expiring = await rows<{ evidence_id: string; title: string; valid_to: string }>(
      env, `SELECT id AS evidence_id, title, valid_to FROM evidence WHERE workspace_id = ? AND valid_to IS NOT NULL AND valid_to <= ? ORDER BY valid_to LIMIT 5`,
      w, new Date(now + 120 * 86_400_000).toISOString().slice(0, 10));
    return {
      new_matches: await n("SELECT COUNT(*) AS n FROM tender_matches WHERE workspace_id = ? AND status = 'new'", w),
      open_intakes: await n("SELECT COUNT(*) AS n FROM intakes WHERE workspace_id = ? AND status IN ('new','classified','processing')", w),
      answers_awaiting_approval: await n("SELECT COUNT(*) AS n FROM answers WHERE workspace_id = ? AND status = 'draft'", w),
      top_matches: matches,
      closing_soon: closing.map((t) => ({ ...t, days_left: Math.round(daysUntil(t.deadline, now) * 10) / 10 })),
      expiring_certificates: expiring.map((e) => ({ ...e, days_left: Math.round(daysUntil(e.valid_to, now)) })),
    };
  },
});

export const searchTenders = defineTool({
  name: 'search_tenders',
  description: "Search this workspace's matched tenders by text (title or buyer), country, status or minimum fit score. Returns compact rows, best fit first.",
  input: z.object({
    q: z.string().max(120).optional(),
    country: z.string().max(40).optional(),
    status: z.enum(['new', 'shortlisted', 'dismissed', 'bidding']).optional(),
    min_fit: z.number().min(0).max(100).optional(),
    limit: limit(25, 10),
  }),
  async run(env, ctx, i) {
    const where = ['m.workspace_id = ?'];
    const b: unknown[] = [ctx.workspaceId];
    if (i.status) { where.push('m.status = ?'); b.push(i.status); }
    if (i.country) { where.push('t.country = ?'); b.push(i.country); }
    if (i.min_fit !== undefined) { where.push('m.fit_score >= ?'); b.push(i.min_fit); }
    if (i.q) { where.push('(t.title LIKE ? OR t.buyer LIKE ?)'); b.push(`%${i.q}%`, `%${i.q}%`); }
    const items = await rows(
      env, `SELECT t.id AS tender_id, t.title, t.buyer, t.country, t.value_eur, t.deadline, m.fit_score, m.fit_reason, m.status
            FROM tender_matches m JOIN tenders t ON t.id = m.tender_id WHERE ${where.join(' AND ')} ORDER BY m.fit_score DESC, t.deadline LIMIT ?`, ...b, i.limit);
    return { count: items.length, items };
  },
});

export const getTender = defineTool({
  name: 'get_tender',
  description: 'What Pactovio already stores about one tender: buyer, value, deadline, lots, documents, the workspace fit score and reason, requirement counts and per-lot verdicts. It does not read the documents; to read a pack use start_pack_run.',
  input: z.object({ tender_id: tenderId }),
  async run(env, ctx, i) {
    const t = await one<Record<string, unknown> & { lots: { lot_no: string; title: string; value_eur?: number | null }[] }>(env, 'SELECT * FROM tenders WHERE id = ?', i.tender_id);
    if (!t) throw new ToolError(`No tender with id ${i.tender_id}`, 'not_found');
    const m = await one<{ fit_score: number; fit_reason: string; status: string }>(env, 'SELECT fit_score, fit_reason, status FROM tender_matches WHERE workspace_id = ? AND tender_id = ?', ctx.workspaceId, i.tender_id);
    const counts = await rows<{ status: string; n: number }>(env, 'SELECT status, COUNT(*) AS n FROM requirements WHERE workspace_id = ? AND tender_id = ? GROUP BY status', ctx.workspaceId, i.tender_id);
    const docs = await rows<{ filename: string; kind: string; pages: number | null; is_form: boolean }>(env, 'SELECT filename, kind, pages, is_form FROM documents WHERE tender_id = ? ORDER BY filename LIMIT 20', i.tender_id);
    const verdicts = await rows<{ lot: string | null; decision: string; score: number }>(env, 'SELECT lot, decision, score FROM verdicts WHERE workspace_id = ? AND tender_id = ? ORDER BY lot', ctx.workspaceId, i.tender_id);
    return {
      tender_id: t.id, title: t.title, buyer: t.buyer, country: t.country, value_eur: t.value_eur, deadline: t.deadline, url: t.url,
      lots: t.lots?.map((l) => ({ lot: l.lot_no, title: l.title, value_eur: l.value_eur ?? null })),
      fit: m ?? null, requirement_counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), documents: docs, verdicts,
    };
  },
});

export const getMatrix = defineTool({
  name: 'get_matrix',
  description: 'Requirement matrix of a tender: each requirement with status MET, PARTIAL, GAP or NEEDS_EVIDENCE, its source page and evidence count. Filter by lot or status. Capped at 30 rows; gaps first.',
  input: z.object({ tender_id: tenderId, lot: z.string().optional(), status: z.enum(['MET', 'PARTIAL', 'GAP', 'NEEDS_EVIDENCE']).optional() }),
  async run(env, ctx, i) {
    await requireTender(env, i.tender_id);
    const where = ['workspace_id = ?', 'tender_id = ?'];
    const b: unknown[] = [ctx.workspaceId, i.tender_id];
    if (i.lot) { where.push('lot = ?'); b.push(i.lot); }
    if (i.status) { where.push('status = ?'); b.push(i.status); }
    const reqs = await rows<{ id: string; lot: string | null; ref: string; text: string; kind: string; status: string; page: number | null; evidence_ids: string[] | null; note: string | null }>(
      env, `SELECT * FROM requirements WHERE ${where.join(' AND ')}
            ORDER BY CASE status WHEN 'GAP' THEN 0 WHEN 'NEEDS_EVIDENCE' THEN 1 WHEN 'PARTIAL' THEN 2 ELSE 3 END, lot, ref LIMIT 30`, ...b);
    const counts = await rows<{ status: string; n: number }>(env, 'SELECT status, COUNT(*) AS n FROM requirements WHERE workspace_id = ? AND tender_id = ? GROUP BY status', ctx.workspaceId, i.tender_id);
    return {
      tender_id: i.tender_id,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      shown: reqs.length,
      requirements: reqs.map((r) => ({ id: r.id, lot: r.lot, ref: r.ref, kind: r.kind, status: r.status, page: r.page, text: clip(r.text, 160), evidence_count: r.evidence_ids?.length ?? 0, note: r.note ? clip(r.note, 120) : null })),
    };
  },
});

export const getVerdicts = defineTool({
  name: 'get_verdicts',
  description: 'Per-lot bid / no-bid / conditional verdicts of a tender with score, the gates that were checked and the reasons.',
  input: z.object({ tender_id: tenderId }),
  async run(env, ctx, i) {
    await requireTender(env, i.tender_id);
    const items = await rows<{ lot: string | null; decision: string; score: number; gates: unknown; reasons: unknown }>(
      env, 'SELECT lot, decision, score, gates_json, reasons_json FROM verdicts WHERE workspace_id = ? AND tender_id = ? ORDER BY lot', ctx.workspaceId, i.tender_id);
    return { tender_id: i.tender_id, count: items.length, items };
  },
});

export const buyerIntelTool = defineTool({
  name: 'buyer_intel',
  description: 'Intelligence on a buyer (what they buy, how they evaluate, recent news). refresh=true makes a live web search (Tavily, capped per session) and needs the user to confirm.',
  input: z.object({ buyer_key: z.string().optional(), tender_id: z.string().optional(), refresh: z.boolean().default(false) }),
  needsConfirmation: (i) => i.refresh === true,
  async describe(env, _ctx, i) {
    const key = await resolveBuyer(env, i);
    return { title: 'Refresh buyer intelligence?', detail: `Runs a live web search about ${key}. Judge sessions get 3 refreshes.` };
  },
  async run(env, ctx, i) {
    const key = await resolveBuyer(env, i);
    try {
      const intel = await buyerIntel(env, key, { refresh: i.refresh, sessionId: ctx.sessionId ?? undefined });
      return { buyer_key: key, summary: intel.summary, facts: intel.facts?.slice?.(0, 8), sources: intel.sources?.slice?.(0, 5), fetched_at: intel.fetched_at };
    } catch (e) {
      if (!(e instanceof NotImplemented)) throw e;
      const row = await one<{ summary: string; facts: unknown[]; sources: unknown[]; fetched_at: string }>(env, 'SELECT * FROM buyer_intel WHERE buyer_key = ?', key);
      if (!row) throw new ToolError(`No intelligence stored for buyer ${key}`, 'not_found');
      return { buyer_key: key, summary: row.summary, facts: row.facts?.slice(0, 8), sources: row.sources?.slice(0, 5), fetched_at: row.fetched_at };
    }
  },
});

async function resolveBuyer(env: Parameters<AgentTool['run']>[0], i: { buyer_key?: string; tender_id?: string }): Promise<string> {
  if (i.buyer_key) return i.buyer_key;
  if (!i.tender_id) throw new ToolError('Give buyer_key or tender_id', 'validation');
  return (await requireTender(env, i.tender_id)).buyer_key;
}

export const listIntakes = defineTool({
  name: 'list_intakes',
  description: 'Inbox of inbound work across the three doors: tenders, RFP/RFQ emails and design requests, newest first.',
  input: z.object({ door: z.enum(['tender', 'rfp', 'design']).optional(), status: z.enum(['new', 'classified', 'processing', 'ready', 'ignored']).optional(), limit: limit(25, 10) }),
  async run(env, ctx, i) {
    const where = ['workspace_id = ?'];
    const b: unknown[] = [ctx.workspaceId];
    if (i.door) { where.push('door = ?'); b.push(i.door); }
    if (i.status) { where.push('status = ?'); b.push(i.status); }
    const items = await rows(env, `SELECT id AS intake_id, door, source, title, sender, received_at, status, tender_id, design_request_id FROM intakes WHERE ${where.join(' AND ')} ORDER BY received_at DESC LIMIT ?`, ...b, i.limit);
    return { count: items.length, items };
  },
});

export const listConnectors = defineTool({
  name: 'list_connectors',
  description: 'Connected third-party tools (email, chat, CRM, files, calendar, project, signing, accounting) and their status.',
  input: z.object({}),
  async run(env, ctx) {
    const items = await rows(env, 'SELECT provider, status, external_account_id, connected_at FROM connectors WHERE workspace_id = ? ORDER BY provider', ctx.workspaceId);
    return { count: items.length, items };
  },
});

export const billingStatus = defineTool({
  name: 'billing_status',
  description: 'Current plan, subscription status and credit balance of the workspace.',
  input: z.object({}),
  async run(env, ctx) {
    try {
      const p = await getPlan(env, ctx.workspaceId);
      return { plan: p.plan, status: p.status, current_period_end: p.currentPeriodEnd, credits_balance: p.creditsBalance };
    } catch (e) {
      if (!(e instanceof NotImplemented)) throw e;
      const sub = await one<{ plan: string; status: string; current_period_end: string | null }>(env, 'SELECT plan, status, current_period_end FROM subscriptions WHERE workspace_id = ?', ctx.workspaceId);
      const bal = await one<{ n: number }>(env, 'SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE workspace_id = ?', ctx.workspaceId);
      return { plan: sub?.plan ?? 'free', status: sub?.status ?? 'active', current_period_end: sub?.current_period_end ?? null, credits_balance: bal?.n ?? 0 };
    }
  },
});

export const getLimits = defineTool({
  name: 'get_limits',
  description: 'Real caps and usage for this session: fresh pack runs, Tavily refreshes, agent turns per minute, and the shared inference quota.',
  input: z.object({}),
  async run(env, ctx) {
    const s = ctx.sessionId ? await one<{ runs_used: number; tavily_used: number }>(env, 'SELECT runs_used, tavily_used FROM judge_sessions WHERE id = ?', ctx.sessionId) : null;
    return {
      pack_runs: { used: s?.runs_used ?? 0, cap: 2 }, tavily_refreshes: { used: s?.tavily_used ?? 0, cap: 3 },
      agent_turns_per_minute: AGENT_CAPS.turnsPerMinute, session_token_budget: AGENT_CAPS.sessionTokenBudget,
      inference: { rpm: 1000, tpm: 2_000_000, note: 'shared Token Factory quota across six products' },
    };
  },
});

