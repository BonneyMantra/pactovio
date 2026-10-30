import { endpoints } from '@pactovio/contracts';
import { sessionAuth } from '../lib/auth';
import { errorResponse, type Register, type Router } from '../lib/router';

export const register: Register = (r) => {
  r.stub(endpoints.listAgentThreads, 'agent threads');
  r.stub(endpoints.createAgentThread, 'agent threads');
  r.stub(endpoints.listAgentMessages, 'agent messages');
  r.stub(endpoints.sendAgentMessage, 'agent chat');
  r.stub(endpoints.confirmAgentAction, 'agent action confirm');
  r.stub(endpoints.declineAgentAction, 'agent action decline');
  mountSocket(r);
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
      return stub.fetch(new Request(url, c.req.raw));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
}
