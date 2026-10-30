import { streamSSE } from 'hono/streaming';
import { endpoints, type PactovioEvent } from '@pactovio/contracts';
import { rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listEvents, async ({ db, workspaceId, query }) => ({
    items: await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? AND at > ? ORDER BY at DESC LIMIT ?', workspaceId, query.since ?? '', query.limit ?? 50),
  }));

  // SSE: `event: <EventType>`, data = PactovioEvent. Sends the last 10 events, then polls; closes after 25s with `event: reconnect`.
  r.on(endpoints.streamEvents, async ({ c, db, workspaceId }) =>
    streamSSE(c, async (s) => {
      const seen = new Set<string>();
      let cursor = '';
      const recent = (await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? ORDER BY at DESC LIMIT 10', workspaceId)).reverse();
      const deadline = Date.now() + 25_000;
      let batch = recent;
      while (Date.now() < deadline && !s.aborted) {
        for (const e of batch) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          cursor = e.at > cursor ? e.at : cursor;
          await s.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
        }
        await s.sleep(1500);
        batch = await rows<PactovioEvent>(db, 'SELECT * FROM events WHERE workspace_id = ? AND at >= ? ORDER BY at', workspaceId, cursor);
      }
      await s.writeSSE({ event: 'reconnect', data: JSON.stringify({ since: cursor }) });
    }),
  );
};
