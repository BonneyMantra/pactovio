import { DatabaseSync } from 'node:sqlite';
import type { SqlLike } from '../src/do/store';

/** node:sqlite behind the same shape as Durable Object SqlStorage, so the hub store is tested without a Durable Object. */
export function memorySql(): SqlLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const st = db.prepare(query);
      const args = bindings as never[];
      if (st.columns().length > 0) {
        const rows = st.all(...args) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      const r = st.run(...args);
      return { toArray: () => [], rowsWritten: Number(r.changes) };
    },
  };
}
