import type { ConnectorRule, PactovioEvent } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { bestDecision, loadGapRows, loadQuote, loadTender, loadVerdicts, quoteCsv, quoteText } from './event-data';
import { makeCtx, type Deps } from './runtime';
import { PROVIDER_ACTIONS } from './providers';
import { effectiveRules, isLive, listConnectors, saveConnector, type ConnectorRow } from './store';
import { addDays, money, truncate, ymd } from './util';
import type { ActionOutput, Input } from './actions';

export interface EventActionResult { provider: string; action: string; ok: boolean; skipped?: string; id?: string | null; url?: string | null; error?: string }

interface Run { env: Env; row: ConnectorRow; event: PactovioEvent; deps: Deps; call(action: string, input: Input): Promise<ActionOutput>; payload: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (r: Run) => Promise<Omit<EventActionResult, 'provider' | 'action' | 'ok'>>;

const tenderIdOf = (p: Record<string, any>) => String(p.tender_id ?? (p.subject_type === 'tender' ? p.subject_id : '') ?? ''); // eslint-disable-line @typescript-eslint/no-explicit-any
const ref = (r: ActionOutput) => ({ id: r.id, url: r.url ?? null });

/** One external object per (provider, kind, subject): a second event updates instead of duplicating. */
const xrefKey = (r: Run, kind: string, subject: string) => `cx:xref:${r.row.workspace_id}:${r.row.provider}:${kind}:${subject}`;

async function describe(r: Run): Promise<string> {
  const { event, env } = r; const p = r.payload; const ws = event.workspace_id;
  switch (event.type) {
    case 'intake.classified': {
      const i = await env.DB.prepare('SELECT title, sender FROM intakes WHERE id = ? AND workspace_id = ?').bind(p.intake_id, ws).first<{ title: string; sender: string | null }>();
      return `*New ${p.door ?? ''} intake:* ${i?.title ?? p.title ?? p.intake_id}${i?.sender ? ` from ${i.sender}` : ''}\nConfidence ${Math.round(Number(p.confidence ?? 0) * 100)}%. ${p.reason ?? ''}`.trim();
    }
    case 'verdict.ready': {
      const t = await loadTender(env, tenderIdOf(p)); const vs = await loadVerdicts(env, ws, tenderIdOf(p));
      const lines = vs.map((v) => `• ${v.lot ? `Lot ${v.lot}: ` : ''}*${v.decision.replace('_', ' ')}* (score ${Math.round(v.score)}) ${truncate(v.reasons[0] ?? '', 140)}`);
      return `*Verdict ready:* ${t?.title ?? tenderIdOf(p)}${t?.buyer ? ` (${t.buyer})` : ''}${t?.deadline ? `\nCloses ${t.deadline.slice(0, 10)}` : ''}\n${lines.join('\n')}`;
    }
    case 'quote.ready': {
      const q = await loadQuote(env, ws, String(p.quote_id ?? p.subject_id ?? ''));
      return q ? `*Quote ready:* ${q.customer ?? q.id}, total ${money(q.total_minor, q.currency)}${q.valid_until ? `, valid to ${q.valid_until.slice(0, 10)}` : ''}` : `*Quote ready:* ${p.quote_id ?? ''}`;
    }
    case 'certificate.expiring':
      return `*Certificate expiring:* ${p.title ?? p.evidence_id ?? 'a certificate'}${p.valid_to ? ` on ${String(p.valid_to).slice(0, 10)}` : ''}. Renew it before the next bid needs it.`;
    default:
      return `*Pactovio:* ${event.type}`;
  }
}

const post_message: Handler = async (r) => ref(await r.call('post_message', { text: await describe(r) }));

const sync_bid: Handler = async (r) => {
  const tid = tenderIdOf(r.payload); const ws = r.event.workspace_id;
  const t = await loadTender(r.env, tid); if (!t) return { skipped: 'tender not found' };
  const vs = await loadVerdicts(r.env, ws, tid); const decision = bestDecision(vs);
  const stage = decision === 'BID' ? 'bidding' : decision === 'CONDITIONAL' ? 'qualifying' : 'lost';
  const sf = r.row.provider === 'salesforce';
  const idKey = sf ? 'opportunity_id' : 'deal_id';
  const name = truncate(`${t.title}${t.buyer ? ` (${t.buyer})` : ''}`, 120);
  const fields = { name, amount: t.value_eur ?? undefined, close_date: t.deadline ?? ymd(addDays(new Date(), 30)), stage, description: `Pactovio bid for ${t.title}. ${t.url ?? ''}`.trim() };
  const known = await r.env.CACHE.get(xrefKey(r, 'tender', tid));
  let out: ActionOutput;
  if (known) { out = await r.call(sf ? 'update_opportunity' : 'update_deal', { [idKey]: known, ...fields }); out.id = known; }
  else out = await r.call(sf ? 'create_opportunity' : 'create_deal', fields);
  if (!out.id) throw new Error('provider returned no id');
  await r.env.CACHE.put(xrefKey(r, 'tender', tid), out.id);
  const body = [`Pactovio verdict: ${decision ?? 'pending'}`, ...vs.map((v) => `${v.lot ? `Lot ${v.lot}` : 'Whole tender'}: ${v.decision} (score ${Math.round(v.score)}). ${v.reasons.join(' ')}`)].join('\n');
  await r.call('add_note', { [idKey]: out.id, body, title: 'Pactovio verdict' });
  return ref(out);
};

const add_deadline: Handler = async (r) => {
  const tid = tenderIdOf(r.payload);
  const t = await loadTender(r.env, tid); if (!t?.deadline) return { skipped: 'tender has no deadline' };
  const made: ActionOutput[] = [];
  const events: [string, string, string][] = [['deadline', `Bid deadline: ${truncate(t.title, 100)}`, t.deadline]];
  const clar = (t.raw.clarification_deadline ?? t.raw.clarifications_deadline) as string | undefined;
  if (clar) events.push(['clarification', `Clarification questions due: ${truncate(t.title, 80)}`, clar]);
  for (const [kind, title, start] of events) {
    const key = xrefKey(r, kind, tid);
    if (await r.env.CACHE.get(key)) continue;
    const out = await r.call('create_event', { title, start, description: `${t.buyer ?? ''} ${t.url ?? ''}`.trim() });
    if (out.id) await r.env.CACHE.put(key, out.id);
    made.push(out);
  }
  return made.length ? ref(made[0]!) : { skipped: 'calendar events already exist' };
};

const create_gap_tasks: Handler = async (r) => {
  const tid = tenderIdOf(r.payload); const ws = r.event.workspace_id;
  const t = await loadTender(r.env, tid); if (!t) return { skipped: 'run is not for a tender' };
  const gaps = await loadGapRows(r.env, ws, tid);
  let first: ActionOutput | null = null; let n = 0;
  for (const g of gaps) {
    const key = xrefKey(r, 'req', g.id);
    if (await r.env.CACHE.get(key)) continue;
    const out = await r.call('create_task', {
      title: truncate(`[${g.status === 'GAP' ? 'GAP' : 'EVIDENCE'}] ${g.ref ?? ''} ${g.text}`.replace(/\s+/g, ' ').trim(), 240),
      description: `Tender: ${t.title}${t.buyer ? ` (${t.buyer})` : ''}\n${g.lot ? `Lot ${g.lot}\n` : ''}Requirement${g.page ? ` (page ${g.page})` : ''}: ${g.text}\nStatus: ${g.status}\n${g.note ?? ''}`.trim(),
      due_date: t.deadline ? ymd(addDays(t.deadline, -3)) : undefined, labels: ['pactovio', g.status === 'GAP' ? 'gap' : 'needs-evidence'],
    });
    if (out.id) await r.env.CACHE.put(key, out.id);
    first ??= out; n++;
  }
  return n ? { ...ref(first!), skipped: undefined } : { skipped: 'no open gaps' };
};

const upload_artifacts: Handler = async (r) => {
  const p = r.payload;
  const key = (p.r2_key ?? p.export_r2_key ?? p.filled_form_r2_key) as string | undefined;
  if (key) return ref(await r.call('upload_file', { r2_key: key, filename: p.filename }));
  if (r.event.type === 'quote.ready') {
    const q = await loadQuote(r.env, r.event.workspace_id, String(p.quote_id ?? p.subject_id ?? '')); if (!q) return { skipped: 'quote not found' };
    return ref(await r.call('upload_file', { filename: `quote-${q.id}.csv`, mimetype: 'text/csv', text: quoteCsv(q) }));
  }
  return { skipped: 'event carries no file' };
};

const APPROVED = new Set(['ready', 'sent', 'accepted']);

const send_quote_for_signature: Handler = async (r) => {
  const q = await loadQuote(r.env, r.event.workspace_id, String(r.payload.quote_id ?? r.payload.subject_id ?? '')); if (!q) return { skipped: 'quote not found' };
  if (!APPROVED.has(q.status)) return { skipped: `quote is ${q.status}, not approved` };
  return ref(await r.call('send_for_signature', { subject: `Quote ${q.id}${q.customer ? ` for ${q.customer}` : ''}`, filename: `quote-${q.id}.txt`, text: quoteText(q) }));
};

const create_estimate: Handler = async (r) => {
  const q = await loadQuote(r.env, r.event.workspace_id, String(r.payload.quote_id ?? r.payload.subject_id ?? '')); if (!q) return { skipped: 'quote not found' };
  if (!APPROVED.has(q.status)) return { skipped: `quote is ${q.status}, not approved` };
  const known = await r.env.CACHE.get(xrefKey(r, 'quote', q.id)); if (known) return { id: known, skipped: 'estimate already exists' };
  const out = await r.call('create_estimate', { customer: { name: q.customer ?? 'Pactovio customer', email: null }, lines: q.lines, currency: q.currency, valid_until: q.valid_until, reference: q.id });
  if (out.id) await r.env.CACHE.put(xrefKey(r, 'quote', q.id), out.id);
  return ref(out);
};

export const EVENT_ACTIONS: Record<string, Handler> = { post_message, sync_bid, add_deadline, create_gap_tasks, upload_artifacts, send_quote_for_signature, create_estimate };

/** Value or list-of-values match; a payload without the key matches (the handler re-checks against the database). */
export function matchesFilter(filter: ConnectorRule['filter'], payload: Record<string, unknown>): boolean {
  return Object.entries(filter ?? {}).every(([k, want]) => {
    if (!(k in payload)) return true;
    return Array.isArray(want) ? want.includes(payload[k]) : payload[k] === want;
  });
}

async function enrich(env: Env, e: PactovioEvent): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (e.type !== 'verdict.ready' || e.payload.decision) return e.payload;
  const d = bestDecision(await loadVerdicts(env, e.workspace_id, tenderIdOf(e.payload)));
  return d ? { ...e.payload, decision: d } : e.payload;
}

/**
 * Lane: connectors. Called by the EVENTS queue consumer (lane F) for every event: runs the enabled rules of every connected
 * connector of the event's workspace. Never throws; each failure is recorded on the connector (`meta.last_action`).
 */
export async function runEventActions(env: Env, event: PactovioEvent, deps: Deps = {}): Promise<EventActionResult[]> {
  // An emailed RFP is "ready" once its pack run finishes (the engine does not know about intakes).
  if (event.type === 'run.completed' && tenderIdOf(event.payload) && event.payload.status !== 'failed') {
    await env.DB.prepare("UPDATE intakes SET status = 'ready' WHERE tender_id = ? AND workspace_id = ? AND status = 'processing'").bind(tenderIdOf(event.payload), event.workspace_id).run().catch(() => undefined);
  }
  const rows = (await listConnectors(env, event.workspace_id)).filter(isLive);
  if (!rows.length) return [];
  const payload = await enrich(env, event).catch(() => event.payload);
  const results: EventActionResult[] = [];
  for (const row of rows) {
    for (const rule of effectiveRules(row.provider, row.meta)) {
      if (!rule.enabled || rule.event !== event.type || !matchesFilter(rule.filter, payload)) continue;
      const handler = EVENT_ACTIONS[rule.action];
      if (!handler || !PROVIDER_ACTIONS[row.provider]) continue;
      const dedupe = `cx:ev:${event.id}:${row.provider}:${rule.action}`;
      if (await env.CACHE.get(dedupe).catch(() => null)) continue; // queue retry of an event already handled
      let res: EventActionResult;
      try {
        const ctx = makeCtx(env, row, deps);
        const call = async (action: string, input: Input) => {
          const def = PROVIDER_ACTIONS[row.provider]![action];
          if (!def) throw new Error(`${row.provider} has no action ${action}`);
          return def.run(input, ctx);
        };
        res = { provider: row.provider, action: rule.action, ok: true, ...(await handler({ env, row, event, deps, call, payload })) };
      } catch (e) {
        res = { provider: row.provider, action: rule.action, ok: false, error: truncate(e instanceof Error ? e.message : String(e), 300) };
        console.error('connector event action failed', row.provider, rule.action, res.error);
      }
      await env.CACHE.put(dedupe, '1', { expirationTtl: 3600 }).catch(() => undefined);
      await saveConnector(env, row.workspace_id, row.provider, { meta: { ...row.meta, last_action: { at: new Date().toISOString(), event: event.type, action: rule.action, ok: res.ok, id: res.id ?? null, url: res.url ?? null, error: res.error ?? null, skipped: res.skipped ?? null } } }).catch(() => undefined);
      results.push(res);
    }
  }
  return results;
}
