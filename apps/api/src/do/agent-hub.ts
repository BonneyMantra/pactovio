import { DurableObject } from 'cloudflare:workers';
import { nextDigestAt, streamToolLoop } from '@pactovio/agent';
import { AgentWsMessage, HttpError, type PactovioEvent } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { runTurn } from './chat';
import { decideAction } from './decide';
import { postDigest, runDaily } from './digest';
import { sessionKeyOf, type HubDeps } from './deps';
import { handleEvent } from './proactive';
import { HubStore, INBOX_THREAD, toPending } from './store';

const SSE_MAX_MS = 5 * 60_000;
const SSE_PING_MS = 15_000;

interface Sub { write(s: string): boolean; close(): void }
const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * One AgentHub per workspace: SQLite-backed threads, messages and pending actions; WebSocket hibernation for the chat;
 * an SSE feed of proactive messages; an alarm for the 06:30 MYT digest, deadline reminders and certificate nudges.
 * Business logic lives in chat.ts, decide.ts, proactive.ts and digest.ts so it can be tested without a Durable Object.
 * Protocol: docs/AGENT.md. Reached only through routes/agent.ts and routes/mcp.ts (internal paths below).
 */
export class AgentHub extends DurableObject<Env> {
  private readonly store: HubStore;
  private readonly subs = new Set<Sub>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new HubStore(ctx.storage.sql);
  }

  private deps(workspaceId: string): HubDeps {
    return {
      env: this.env, store: this.store, workspaceId, now: Date.now, loop: streamToolLoop,
      send: (frame, scope) => {
        const data = JSON.stringify(frame);
        for (const ws of this.ctx.getWebSockets()) {
          const att = ws.deserializeAttachment() as { session?: string } | null;
          if (scope?.session && att?.session !== scope.session) continue;
          try { ws.send(data); } catch { /* closed socket */ }
        }
      },
      publish: (m) => {
        const data = `event: message\nid: ${m.id}\ndata: ${JSON.stringify({ workspace_id: workspaceId, event_type: m.event_type, message: m })}\n\n`;
        for (const s of this.subs) if (!s.write(data)) this.subs.delete(s);
      },
    };
  }

  private workspace(request?: Request): string {
    const fromReq = request?.headers.get('x-pv-workspace') || (request ? new URL(request.url).searchParams.get('workspace') : null);
    if (fromReq) { if (this.store.getKv('workspace') !== fromReq) this.store.setKv('workspace', fromReq); return fromReq; }
    const stored = this.store.getKv('workspace');
    if (!stored) throw new HttpError(400, 'Workspace unknown for this agent', 'validation');
    return stored;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const ws = this.workspace(request);
      const session = request.headers.get('x-pv-session') || url.searchParams.get('session') || null;
      const key = sessionKeyOf(session);
      this.store.ensureInbox();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(nextDigestAt(Date.now()));

      if (path === '/ws') return this.upgrade(request, ws, key);
      if (path === '/notify' && request.method === 'POST') {
        await handleEvent(this.deps(ws), (await request.json()) as PactovioEvent);
        return new Response(null, { status: 204 });
      }
      if (path === '/ensure') return json({ ok: true, alarm: await this.ctx.storage.getAlarm() });
      if (path === '/threads' && request.method === 'GET') return json({ items: this.store.listThreads(key) });
      if (path === '/threads' && request.method === 'POST') return json(this.store.createThread(key, 'New chat'));
      const msgs = /^\/threads\/([^/]+)\/messages$/.exec(path);
      if (msgs && request.method === 'GET') {
        if (!this.store.canSee(msgs[1]!, key)) throw new HttpError(404, 'Thread not found', 'not_found');
        return json({ items: this.store.listMessages(msgs[1]!) });
      }
      if (path === '/message' && request.method === 'POST') {
        const b = (await request.json()) as { content: string; thread_id?: string };
        return json(await runTurn(this.deps(ws), { sessionId: session, threadId: b.thread_id, content: b.content }));
      }
      if (path === '/pending' && request.method === 'POST') return json(await this.pending(ws, await request.json()));
      const act = /^\/actions\/([^/]+)$/.exec(path);
      if (act && request.method === 'POST') {
        const b = (await request.json()) as { decision: 'confirm' | 'decline'; trusted?: boolean };
        return json(await decideAction(this.deps(ws), act[1]!, b.decision, { sessionId: session, trusted: b.trusted === true }));
      }
      if (act && request.method === 'GET') {
        const a = this.store.getAction(act[1]!);
        return a ? json(toPending(a)) : json({ error: 'Action not found', code: 'not_found' }, 404);
      }
      if (path === '/digest' && request.method === 'POST') {
        const message = await postDigest(this.deps(ws));
        return json({ thread_id: INBOX_THREAD, message });
      }
      if (path === '/events' && request.method === 'GET') return this.sse(url.searchParams.get('since') ?? request.headers.get('last-event-id') ?? undefined);
      return json({ error: 'Not found', code: 'not_found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code ?? 'error' }, e.status);
      console.error('agent hub error', e instanceof Error ? e.name : 'unknown');
      return json({ error: 'Internal error', code: 'internal' }, 500);
    }
  }

  /** MCP and other non-chat callers: a confirmation-required tool call becomes a pending action shown in the chat. */
  private async pending(ws: string, raw: unknown) {
    const b = raw as { tool: string; input: Record<string, unknown>; title: string; detail: string; summary: string };
    const action = this.store.createAction({ thread_id: INBOX_THREAD, session_id: null, tool: b.tool, input: b.input, title: b.title, detail: b.detail, summary: b.summary, source: 'mcp' });
    const message = this.store.addMessage({ thread_id: INBOX_THREAD, role: 'assistant', content: `An external agent asked to: ${b.title} ${b.detail}`.trim(), action_id: action.id, event_type: 'mcp.action' });
    const d = this.deps(ws);
    d.send({ type: 'assistant_message', message });
    d.send({ type: 'approval_requested', action: toPending(action), thread_id: INBOX_THREAD });
    d.publish({ ...message, event_type: 'mcp.action' });
    return toPending(action);
  }

  private upgrade(request: Request, workspaceId: string, sessionKey: string): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ session: sessionKey });
    pair[1].send(JSON.stringify({ type: 'event', event_type: 'agent.connected', payload: { workspace_id: workspaceId, inbox_thread: INBOX_THREAD } }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private sse(since: string | undefined): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    let timers: ReturnType<typeof setTimeout>[] = [];
    const sub: Sub = {
      write: (s) => { writer.write(enc.encode(s)).catch(() => this.subs.delete(sub)); return true; },
      close: () => { timers.forEach(clearTimeout); timers = []; this.subs.delete(sub); writer.close().catch(() => undefined); },
    };
    const ws = this.store.getKv('workspace') ?? '';
    sub.write('retry: 3000\n: connected\n\n');
    if (since) {
      for (const m of this.store.inboxSince(since)) sub.write(`event: message\nid: ${m.id}\ndata: ${JSON.stringify({ workspace_id: ws, event_type: m.event_type, message: m })}\n\n`);
    }
    const ping = () => { sub.write(': ping\n\n'); timers.push(setTimeout(ping, SSE_PING_MS)); };
    timers.push(setTimeout(ping, SSE_PING_MS));
    timers.push(setTimeout(() => { sub.write('event: reconnect\ndata: {}\n\n'); sub.close(); }, SSE_MAX_MS));
    this.subs.add(sub);
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const reply = (frame: unknown) => { try { ws.send(JSON.stringify(frame)); } catch { /* closed */ } };
    let frame: AgentWsMessage;
    try {
      frame = AgentWsMessage.parse(JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)));
    } catch {
      return reply({ type: 'error', error: 'Unrecognised frame', code: 'validation' });
    }
    const att = ws.deserializeAttachment() as { session?: string } | null;
    const session = att?.session && att.session !== 'apikey' ? att.session : null;
    try {
      const d = this.deps(this.workspace());
      if (frame.type === 'user_message') await runTurn(d, { sessionId: session, threadId: frame.thread_id, content: frame.content });
      else if (frame.type === 'action_decision') await decideAction(d, frame.action_id, frame.decision, { sessionId: session });
      else if (frame.type === 'ping') reply({ type: 'event', event_type: 'pong', payload: {} });
    } catch (e) {
      if (e instanceof HttpError) reply({ type: 'error', error: e.message, code: e.code });
      else reply({ type: 'error', error: 'Internal error', code: 'internal' });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }

  async alarm(): Promise<void> {
    try {
      const ws = this.store.getKv('workspace');
      if (ws) await runDaily(this.deps(ws));
    } catch (e) {
      console.error('agent alarm failed', e instanceof Error ? e.name : 'unknown');
    }
    await this.ctx.storage.setAlarm(nextDigestAt(Date.now()));
  }
}

