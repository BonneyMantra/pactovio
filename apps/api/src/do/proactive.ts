import { mapEvent, signDecision, type ProactiveAction } from '@pactovio/agent';
import type { AgentMessage, PactovioEvent } from '@pactovio/contracts';
import { runAction } from '@pactovio/connectors';
import { BASE_URL, type HubDeps } from './deps';
import { INBOX_THREAD, toPending } from './store';

const CHAT_PROVIDERS = ['slack', 'teams', 'microsoftteams'];

/** Add what the pure mapper needs but the event payload may lack: tender title, buyer, deadline, fit. */
async function enrich(deps: HubDeps, event: PactovioEvent): Promise<Record<string, unknown>> {
  const p = { ...event.payload };
  try {
    if (typeof p.answer_id === 'string' && !p.draft) {
      const a = await deps.env.DB.prepare('SELECT question_ref, draft, tender_id FROM answers WHERE id = ? AND workspace_id = ?').bind(p.answer_id, deps.workspaceId).first<{ question_ref: string; draft: string; tender_id: string }>();
      if (a) { p.draft = a.draft; p.question_ref ??= a.question_ref; p.tender_id ??= a.tender_id; }
    }
  } catch { /* enrichment is best effort */ }
  const tid = typeof p.tender_id === 'string' ? p.tender_id : undefined;
  if (!tid || (p.title && p.buyer && p.deadline)) return p;
  try {
    const t = await deps.env.DB.prepare('SELECT t.title, t.buyer, t.deadline, m.fit_score FROM tenders t LEFT JOIN tender_matches m ON m.tender_id = t.id AND m.workspace_id = ? WHERE t.id = ?')
      .bind(deps.workspaceId, tid).first<{ title: string; buyer: string; deadline: string | null; fit_score: number | null }>();
    if (t) {
      p.title ??= t.title; p.buyer ??= t.buyer; p.deadline ??= t.deadline ?? undefined;
      if (event.type === 'tender.matched' && p.fit_score === undefined && t.fit_score !== null) p.fit_score = t.fit_score;
    }
  } catch { /* enrichment is best effort */ }
  return p;
}

/** Store a proactive message in the inbox, push it to sockets and SSE subscribers, mirror it to connected chat tools. */
export async function postProactive(
  deps: HubDeps,
  m: { text: string; action?: ProactiveAction; event_type: string; event_id?: string; source: 'event' | 'digest' },
): Promise<AgentMessage> {
  const { store } = deps;
  store.ensureInbox();
  const action = m.action
    ? store.createAction({ thread_id: INBOX_THREAD, session_id: null, tool: m.action.tool, input: m.action.input, title: m.action.title, detail: m.action.detail, summary: `${m.action.title} ${m.action.detail}`, source: m.source, event_id: m.event_id })
    : undefined;
  const message = store.addMessage({ thread_id: INBOX_THREAD, role: 'assistant', content: m.text, action_id: action?.id, event_type: m.event_type });
  deps.send({ type: 'assistant_message', message });
  if (action) deps.send({ type: 'approval_requested', action: toPending(action), thread_id: INBOX_THREAD });
  deps.publish({ ...message, event_type: m.event_type });
  await mirror(deps, m.text, action?.id);
  return message;
}

/** Turn a domain event into an agent message (with an action request where useful). Dedupes redelivered events. */
export async function handleEvent(deps: HubDeps, event: PactovioEvent): Promise<AgentMessage | null> {
  if (!deps.store.markEvent(event.id)) return null;
  deps.send({ type: 'event', event_type: event.type, payload: event.payload });
  const pm = mapEvent({ id: event.id, type: event.type, payload: await enrich(deps, event) });
  if (!pm) return null;
  return postProactive(deps, { text: pm.text, action: pm.action, event_type: pm.event_type, event_id: pm.event_id, source: 'event' });
}

/** Post to Slack/Teams when connected, with signed approve/decline links for an action request. Never throws. */
async function mirror(deps: HubDeps, text: string, actionId: string | undefined): Promise<void> {
  const { env, workspaceId } = deps;
  try {
    const conns = await env.DB.prepare(`SELECT provider, meta_json FROM connectors WHERE workspace_id = ? AND status = 'connected' AND provider IN (${CHAT_PROVIDERS.map(() => '?').join(',')})`)
      .bind(workspaceId, ...CHAT_PROVIDERS).all<{ provider: string; meta_json: string | null }>();
    // Seeded sample connectors are labels, not live accounts: never try to post through them.
    const live = conns.results.filter((c) => !(c.meta_json && (JSON.parse(c.meta_json) as { sample?: boolean }).sample));
    if (!live.length) return;
    const secret = env.WEBHOOK_SIGNING_SECRET ?? (env.ENVIRONMENT === 'development' ? 'dev-webhook-signing' : undefined);
    let links: { confirm: string; decline: string } | undefined;
    if (actionId && secret) {
      const url = (d: 'confirm' | 'decline', t: string) => `${BASE_URL(env)}/api/agent/actions/${actionId}/link?w=${encodeURIComponent(workspaceId)}&d=${d}&t=${t}`;
      links = { confirm: url('confirm', await signDecision(secret, workspaceId, actionId, 'confirm')), decline: url('decline', await signDecision(secret, workspaceId, actionId, 'decline')) };
    }
    for (const c of live) {
      const teams = c.provider !== 'slack';
      const body = links ? (teams ? `${text}\n\n[Approve](${links.confirm}) | [Decline](${links.decline})` : `${text}\n<${links.confirm}|Approve> | <${links.decline}|Decline>`) : text;
      const meta = c.meta_json ? (JSON.parse(c.meta_json) as { channel?: string }) : {};
      await runAction(env, workspaceId, c.provider, 'post_message', { text: body, ...(meta.channel ? { channel: meta.channel } : {}) }).catch(() => undefined);
    }
  } catch (e) {
    console.error('agent mirror failed', e instanceof Error ? e.name : 'unknown');
  }
}
