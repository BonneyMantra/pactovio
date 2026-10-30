import { DurableObject } from 'cloudflare:workers';
import type { Env } from '@pactovio/contracts/env';

/**
 * One AgentHub per workspace (SQLite-backed, WebSocket hibernation, alarms).
 * Foundation: accepts sockets, fans out /notify events, answers user messages with a not_implemented frame.
 * Lane: agent replaces `webSocketMessage` with the tool loop over `agentTools` and creates the
 * agent_threads / agent_messages tables in the constructor (DO SQLite).
 */
export class AgentHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      const event = (await request.json()) as { type: string; payload: Record<string, unknown> };
      const frame = JSON.stringify({ type: 'event', event_type: event.type, payload: event.payload });
      for (const ws of this.ctx.getWebSockets()) ws.send(frame);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: 'event', event_type: 'agent.connected', payload: { workspace_id: url.searchParams.get('workspace') } }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    ws.send(JSON.stringify({ type: 'error', error: 'Agent chat is not implemented yet', code: 'not_implemented' }));
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code, 'closing');
  }
}
