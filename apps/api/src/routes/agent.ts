import { reserveAgentTurn } from '@pactovio/billing';
import { endpoints, type AgentMessage, type AgentThread, type AgentTurnResult, type PendingAction } from '@pactovio/contracts';
import { hubFetch, hubJson } from '../do/client';
import { sessionAuth } from '../lib/auth';
import { errorResponse, type Register, type Router } from '../lib/router';
import { mountActionLinks, mountDevEmit } from './agent-links';

export const register: Register = (r) => {
  r.on(endpoints.listAgentThreads, ({ env, auth }) => hubJson<{ items: AgentThread[] }>(env, auth, '/threads'));
  r.on(endpoints.createAgentThread, ({ env, auth }) => hubJson<AgentThread>(env, auth, '/threads', { method: 'POST', body: {} }));
  r.on(endpoints.listAgentMessages, ({ env, auth, params }) => hubJson<{ items: AgentMessage[] }>(env, auth, `/threads/${encodeURIComponent(params.id)}/messages`));
  r.on(endpoints.sendAgentMessage, async ({ env, auth, params, body }) => {
    await reserveAgentTurn(env, auth.sessionId ?? null);
    const turn = await hubJson<AgentTurnResult>(env, auth, '/message', { body: { content: body.content, thread_id: params.id } });
    return [...turn.messages].reverse().find((m) => m.role === 'assistant' && !m.pending_action) ?? turn.messages[turn.messages.length - 1]!;
  });
  r.on(endpoints.postAgentMessage, async ({ env, auth, body }) => {
    await reserveAgentTurn(env, auth.sessionId ?? null); // D1-backed 10/min per judge session, shared by every isolate (the hub keeps its own window for sockets)
    return hubJson<AgentTurnResult>(env, auth, '/message', { body });
  });
  r.on(endpoints.confirmAgentAction, ({ env, auth, params }) => hubJson<PendingAction>(env, auth, `/actions/${encodeURIComponent(params.id)}`, { body: { decision: 'confirm' } }));
  r.on(endpoints.declineAgentAction, ({ env, auth, params }) => hubJson<PendingAction>(env, auth, `/actions/${encodeURIComponent(params.id)}`, { body: { decision: 'decline' } }));
  r.on(endpoints.decideAgentAction, ({ env, auth, params, body }) => hubJson<PendingAction>(env, auth, `/actions/${encodeURIComponent(params.id)}`, { body: { decision: body.decision } }));
  r.on(endpoints.runAgentDigest, ({ env, auth }) => hubJson(env, auth, '/digest', { method: 'POST', body: {} }));
  // SSE of proactive messages for outbound subscribers (the Mac desk agent uses /v1 with an API key). `?since=<message id>` resumes.
  r.on(endpoints.streamAgentEvents, async ({ c, env, auth }) => {
    const since = c.req.query('since') ?? c.req.header('last-event-id');
    return hubFetch(env, auth, `/events${since ? `?since=${encodeURIComponent(since)}` : ''}`);
  });
  mountSocket(r);
  if (r.mode === 'session') { mountActionLinks(r); mountDevEmit(r); }
};

/** WebSocket upgrade -> the workspace's AgentHub DO. Registered directly (not via r.on) because it returns a 101. */
function mountSocket(r: Router) {
  r.registered.add(endpoints.agentSocket.id);
  r.app.get('/agent/ws', async (c) => {
    try {
      if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
        return c.json({ error: 'Expected a WebSocket upgrade', code: 'upgrade_required' }, 426);
      }
      const auth = await sessionAuth(c);
      const stub = c.env.AGENT.get(c.env.AGENT.idFromName(auth.workspaceId));
      const url = new URL(c.req.url);
      url.pathname = '/ws';
      url.searchParams.set('workspace', auth.workspaceId);
      url.searchParams.set('session', auth.sessionId ?? '');
      return stub.fetch(new Request(url, c.req.raw));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
}
