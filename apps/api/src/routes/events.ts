import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { endpoints, type PactovioEvent } from '@pactovio/contracts';
import { one, rows } from '../lib/db';
import type { AppEnv } from '../lib/types';
import type { Register } from '../lib/router';

/**
 * SSE: `event: <EventType>`, `id` = event id, data = PactovioEvent. Replays the last 10 (or everything after the
 * `Last-Event-ID` header / `?since=`), then polls; closes after 25s with `event: reconnect`.
 */
export function eventStream(c: Context<AppEnv>, db: D1Database, workspaceId: string, since?: string): Response {
  return streamSSE(c, async (s) => {
    const seen = new Set<string>();
    let cursor = since ?? '';
    const lastId = c.req.header('last-event-id');
    if (lastId) cursor = (await one<{ at: string }>(db, 'SELECT at FROM events WHERE id = ? AND workspace_id = ?', lastId, workspaceId))?.at ?? cursor;
    let batch = cursor
      ? await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? AND at >= ? ORDER BY at LIMIT 200', workspaceId, cursor)
      : (await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? ORDER BY at DESC LIMIT 10', workspaceId)).reverse();
    if (lastId) seen.add(lastId);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !s.aborted) {
      for (const e of batch) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        cursor = e.at > cursor ? e.at : cursor;
        await s.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
      }
      await s.sleep(1500);
      batch = await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? AND at >= ? ORDER BY at LIMIT 200', workspaceId, cursor);
    }
    await s.writeSSE({ event: 'reconnect', data: JSON.stringify({ since: cursor }) });
  });
}

export const register: Register = (r) => {
  // `GET /events` is JSON by default; with `Accept: text/event-stream` it is the live stream (same as /events/stream).
  r.on(endpoints.listEvents, async ({ c, db, workspaceId, query }) => {
    if ((c.req.header('accept') ?? '').includes('text/event-stream')) return eventStream(c, db, workspaceId, query.since);
    return { items: await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? AND at > ? ORDER BY at DESC LIMIT ?', workspaceId, query.since ?? '', query.limit ?? 50) };
  });
  r.on(endpoints.streamEvents, async ({ c, db, workspaceId }) => eventStream(c, db, workspaceId));
};
