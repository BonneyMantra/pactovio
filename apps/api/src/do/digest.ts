import { dueCertificateNudges, dueDeadlineReminders, getTool, renderDigest, type TodayLike } from '@pactovio/agent';
import type { AgentMessage } from '@pactovio/contracts';
import type { HubDeps } from './deps';
import { postProactive } from './proactive';

const MAX_REMINDERS_PER_RUN = 6;

/** The 06:30 MYT digest. Numbers come from the list_today tool, wording from code. */
export async function postDigest(deps: HubDeps): Promise<AgentMessage> {
  const { env, workspaceId } = deps;
  const today = (await getTool('list_today')!.run(env, { workspaceId, source: 'digest' }, {})) as TodayLike;
  const ws = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(workspaceId).first<{ name: string }>();
  const d = renderDigest(today, ws?.name ?? workspaceId, deps.now());
  return postProactive(deps, { text: d.text, action: d.action, event_type: 'agent.digest', source: 'digest' });
}

/** Alarm body: digest, then deadline (7/2/1 days) and certificate-expiry nudges not yet sent. */
export async function runDaily(deps: HubDeps): Promise<{ digest: boolean; reminders: number }> {
  const { env, workspaceId, store } = deps;
  const now = deps.now();
  let digest = false;
  try { await postDigest(deps); digest = true; } catch (e) { console.error('agent digest failed', e instanceof Error ? e.name : 'unknown'); }
  const sent = store.sentKeys();
  const tenders = await env.DB.prepare(
    `SELECT t.id AS tender_id, t.title, t.deadline FROM tenders t JOIN tender_matches m ON m.tender_id = t.id
     WHERE m.workspace_id = ? AND m.status != 'dismissed' AND t.deadline > ? AND t.deadline < ?`,
  ).bind(workspaceId, new Date(now).toISOString(), new Date(now + 8 * 86_400_000).toISOString()).all<{ tender_id: string; title: string; deadline: string }>();
  const certs = await env.DB.prepare(
    'SELECT id AS evidence_id, title, valid_to FROM evidence WHERE workspace_id = ? AND valid_to IS NOT NULL AND valid_to <= ?',
  ).bind(workspaceId, new Date(now + 61 * 86_400_000).toISOString().slice(0, 10)).all<{ evidence_id: string; title: string; valid_to: string }>();
  const due = [
    ...dueDeadlineReminders(tenders.results, now, sent).map((r) => ({ ...r, type: 'tender.deadline' })),
    ...dueCertificateNudges(certs.results, now, sent).map((r) => ({ ...r, type: 'certificate.expiring' })),
  ].slice(0, MAX_REMINDERS_PER_RUN);
  for (const r of due) {
    store.markSent(r.key);
    await postProactive(deps, { text: r.text, event_type: r.type, source: 'digest' });
  }
  return { digest, reminders: due.length };
}
