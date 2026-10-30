import { streamSSE } from 'hono/streaming';
import { endpoints, HttpError, type Run, type RunStep } from '@pactovio/contracts';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  const getRun = async (db: D1Database, id: string, ws: string) => {
    const run = await one<Run>(db, 'SELECT * FROM runs WHERE id = ? AND workspace_id = ?', id, ws);
    if (!run) throw new HttpError(404, 'Run not found', 'not_found');
    return run;
  };

  r.on(endpoints.getRun, async ({ db, workspaceId, params }) => ({
    run: await getRun(db, params.id, workspaceId),
    steps: await rows<RunStep>(db, 'SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq', params.id),
  }));

  // SSE: `event: step` per run_step (data = RunStep), then `event: done` (data = Run). Replays existing steps first.
  r.on(endpoints.streamRun, async ({ c, db, workspaceId, params }) => {
    await getRun(db, params.id, workspaceId);
    return streamSSE(c, async (s) => {
      let last = 0;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !s.aborted) {
        for (const st of await rows<RunStep>(db, 'SELECT * FROM run_steps WHERE run_id = ? AND seq > ? ORDER BY seq', params.id, last)) {
          await s.writeSSE({ event: 'step', id: String(st.seq), data: JSON.stringify(st) });
          last = st.seq;
        }
        const run = await getRun(db, params.id, workspaceId);
        if (run.status === 'completed' || run.status === 'failed') {
          await s.writeSSE({ event: 'done', data: JSON.stringify(run) });
          return;
        }
        await s.sleep(1000);
      }
      await s.writeSSE({ event: 'reconnect', data: JSON.stringify({ last_seq: last }) });
    });
  });
};
