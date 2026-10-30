import { invokeTool } from '@pactovio/agent';
import type { AgentMessage, PendingAction } from '@pactovio/contracts';
import { refuse, sessionKeyOf, type HubDeps } from './deps';
import { INBOX_THREAD, toPending } from './store';
import { summarizeResult } from './summarize';

/**
 * Confirm or decline a pending action. This is the ONLY place a confirmation-required tool runs (`confirmed: true`).
 * `trusted` is for signed Slack/Teams links, where the HMAC token already proved the decision.
 */
export async function decideAction(
  deps: HubDeps,
  actionId: string,
  decision: 'confirm' | 'decline',
  who: { sessionId: string | null; trusted?: boolean },
): Promise<PendingAction> {
  const { store, env, workspaceId } = deps;
  const action = store.getAction(actionId);
  if (!action) return refuse(404, 'Action not found', 'not_found');
  // Chat-created actions belong to that judge session; event, digest and MCP actions are workspace-wide.
  if (!who.trusted && action.session_id && action.session_id !== sessionKeyOf(who.sessionId)) return refuse(403, 'This action belongs to another session', 'forbidden');
  if (!store.claimAction(actionId, decision === 'confirm' ? 'confirmed' : 'declined')) {
    return refuse(409, `Action already ${store.getAction(actionId)?.status ?? 'decided'}`, 'conflict');
  }
  const threadId = action.thread_id ?? INBOX_THREAD;
  const scope = action.session_id ? { session: action.session_id } : undefined;

  let message: AgentMessage;
  if (decision === 'decline') {
    message = store.addMessage({ thread_id: threadId, role: 'assistant', content: `Declined: ${action.title ?? action.tool}` });
  } else {
    const o = await invokeTool(env, { workspaceId, sessionId: action.session_id, threadId, source: action.source ?? 'chat', confirmed: true }, action.tool, action.input);
    if (o.status === 'ok') {
      store.finishAction(actionId, 'executed', o.result);
      message = store.addMessage({ thread_id: threadId, role: 'assistant', content: summarizeResult(action.tool, action.title ?? action.tool, o.result) });
    } else {
      const err = o.status === 'error' ? o : { error: 'Needs confirmation again', code: 'internal' };
      store.finishAction(actionId, 'failed', { error: err.error, code: err.code });
      message = store.addMessage({ thread_id: threadId, role: 'assistant', content: `That did not work: ${err.error}` });
    }
  }
  const done = toPending(store.getAction(actionId)!);
  deps.send({ type: 'action_result', action: done, message }, scope);
  return done;
}
