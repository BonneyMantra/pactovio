import {
  AGENT_CAPS, agentTools, checkTokenBudget, checkTurnCap, invokeTool, systemPrompt, type ToolRunResult,
} from '@pactovio/agent';
import type { AgentMessage, PendingAction } from '@pactovio/contracts';
import type { ChatMessage } from '@pactovio/models';
import { refuse, sessionKeyOf, type HubDeps } from './deps';
import { clipJson } from './summarize';
import { toPending, type ThreadRow } from './store';

export interface TurnResult {
  thread_id: string;
  messages: AgentMessage[];
  pending_actions: PendingAction[];
}

/** One chat turn: caps, thread, tool loop with streaming, confirmation gating, persistence. */
export async function runTurn(deps: HubDeps, input: { sessionId: string | null; threadId?: string; content: string }): Promise<TurnResult> {
  const { store, env, workspaceId } = deps;
  const session = sessionKeyOf(input.sessionId);
  const scope = { session };
  const now = deps.now();

  const cap = checkTurnCap(store.turnStamps(session, now - 60_000), now);
  if (!cap.ok) refuse(429, `Agent turn limit reached (${AGENT_CAPS.turnsPerMinute} per minute). Try again in ${cap.retryAfterSec}s.`, 'rate_limited');
  if (!checkTokenBudget(store.usage(session).tokens).ok) refuse(429, 'This session has used its agent token budget.', 'budget_exhausted');

  let thread: ThreadRow | undefined = input.threadId ? store.getThread(input.threadId) : undefined;
  if (input.threadId && (!thread || !store.canSee(input.threadId, session) || thread.kind === 'inbox')) refuse(404, 'Thread not found', 'not_found');
  thread ??= store.createThread(session, input.content.replace(/\s+/g, ' ').slice(0, 48));
  const threadId = thread!.id;
  deps.send({ type: 'thread', thread: { id: thread!.id, title: thread!.title, created_at: thread!.created_at, updated_at: thread!.updated_at } }, scope);

  store.logTurn(session);
  const out: AgentMessage[] = [];
  const pending: PendingAction[] = [];
  const userMsg = store.addMessage({ thread_id: threadId, role: 'user', content: input.content });
  out.push(userMsg);

  const ws = await env.DB.prepare('SELECT name, segment FROM workspaces WHERE id = ?').bind(workspaceId).first<{ name: string; segment: string }>();
  const history: ChatMessage[] = store.listMessages(threadId, 16)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.id !== userMsg.id && !m.pending_action)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt({ workspaceName: ws?.name ?? workspaceId, segment: ws?.segment, now }) },
    ...history,
    { role: 'user', content: input.content },
  ];

  const trace: NonNullable<AgentMessage['tool_calls']> = [];
  const runTool = async (call: { id: string; name: string; input: unknown }): Promise<ToolRunResult> => {
    const o = await invokeTool(env, { workspaceId, sessionId: input.sessionId, threadId, source: 'chat' }, call.name, call.input);
    const inputObj = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
    if (o.status === 'ok') {
      trace.push({ name: call.name, input: inputObj, output: clipJson(o.result, 1500) });
      return { status: 'ok', output: o.result, content: JSON.stringify(clipJson(o.result, 6000)) };
    }
    if (o.status === 'error') {
      trace.push({ name: call.name, input: inputObj, output: { error: o.error, code: o.code } });
      return { status: 'error', output: { error: o.error, code: o.code }, content: JSON.stringify({ error: o.error, code: o.code }) };
    }
    const action = store.createAction({ thread_id: threadId, session_id: input.sessionId, tool: o.tool, input: o.input, title: o.title, detail: o.detail, summary: o.summary, source: 'chat' });
    const card = store.addMessage({ thread_id: threadId, role: 'assistant', content: `${o.title} ${o.detail}`.trim(), action_id: action.id });
    out.push(card);
    pending.push(toPending(action));
    deps.send({ type: 'approval_requested', action: toPending(action), thread_id: threadId }, scope);
    trace.push({ name: call.name, input: inputObj, output: { status: 'pending_confirmation', action_id: action.id } });
    return {
      status: 'pending_confirmation', output: { action_id: action.id },
      content: JSON.stringify({ status: 'pending_confirmation', action_id: action.id, note: 'Shown to the user as a confirmation card. Nothing has been done yet. Do not say it was done.' }),
    };
  };

  let text: string;
  try {
    const res = await deps.loop({
      env, messages, tools: agentTools, runTool,
      onDelta: (delta) => deps.send({ type: 'assistant_delta', thread_id: threadId, delta }, scope),
      onToolCall: (c) => deps.send({ type: 'tool_call', thread_id: threadId, call_id: c.id, name: c.name, input: (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>, status: c.status, ...(c.output !== undefined ? { output: clipJson(c.output, 800) } : {}) }, scope),
    });
    store.addUsage(session, res.tokensIn + res.tokensOut, res.costUsd);
    text = res.text || (pending.length ? 'Waiting for your confirmation above.' : 'I have nothing to add.');
  } catch (e) {
    console.error('agent turn failed', e instanceof Error ? e.name : 'unknown');
    deps.send({ type: 'error', error: 'The agent could not reach the model. Try again in a moment.', code: 'model_error' }, scope);
    deps.send({ type: 'done', thread_id: threadId }, scope);
    return refuse(502, 'The agent could not reach the model. Try again in a moment.', 'model_error');
  }
  const reply = store.addMessage({ thread_id: threadId, role: 'assistant', content: text, tool_calls: trace.length ? trace : undefined });
  out.push(reply);
  deps.send({ type: 'assistant_message', message: reply }, scope);
  deps.send({ type: 'done', thread_id: threadId }, scope);
  return { thread_id: threadId, messages: out, pending_actions: pending };
}

