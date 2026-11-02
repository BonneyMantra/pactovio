import { DatabaseSync } from 'node:sqlite';
import type { Env } from '@pactovio/contracts/env';

/** In-process storage adapter for sandboxed tests where workerd cannot bind a loopback socket.
 * Executes real SQLite (including constraints/transactions/RETURNING), never product result fixtures.
 */
export function localStorageEnv(): { env: Env; dispose: () => Promise<void> } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  class Statement {
    constructor(private sql: string, private args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Statement(this.sql, args); }
    private statement() { return sqlite.prepare(this.sql); }
    async first(column?: string) {
      const row = this.statement().get(...this.args as never[]) as Record<string, unknown> | undefined;
      return column ? row?.[column] ?? null : row ?? null;
    }
    async all() {
      const results = this.statement().all(...this.args as never[]);
      return { results, success: true, meta: { changes: 0 } };
    }
    async run() {
      const out = this.statement().run(...this.args as never[]);
      return { results: [], success: true, meta: { changes: Number(out.changes), last_row_id: Number(out.lastInsertRowid) } };
    }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec('BEGIN');
      try { const out = []; for (const statement of statements) out.push(await statement.run()); sqlite.exec('COMMIT'); return out; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;
  const kv = new Map<string, { value: string; expires: number }>();
  const cache = {
    get: async (key: string, type?: string) => {
      const item = kv.get(key); if (!item || item.expires < Date.now()) return null;
      return type === 'json' ? JSON.parse(item.value) : item.value;
    },
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      kv.set(key, { value, expires: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : Infinity });
    },
    delete: async (key: string) => { kv.delete(key); },
  } as unknown as KVNamespace;
  const files = new Map<string, { bytes: Uint8Array; httpMetadata?: object; customMetadata?: object }>();
  const bucket = {
    put: async (key: string, value: BodyInit, opts?: { httpMetadata?: object; customMetadata?: object }) => {
      files.set(key, { bytes: new Uint8Array(await new Response(value).arrayBuffer()), ...opts }); return { key };
    },
    head: async (key: string) => { const item = files.get(key); return item ? { key, size: item.bytes.length } : null; },
    get: async (key: string) => {
      const item = files.get(key); if (!item) return null;
      return { ...item, key, size: item.bytes.length, body: new Response(item.bytes).body,
        arrayBuffer: async () => item.bytes.slice().buffer, text: async () => new TextDecoder().decode(item.bytes),
        json: async () => JSON.parse(new TextDecoder().decode(item.bytes)) };
    },
    delete: async (key: string) => { files.delete(key); },
  } as unknown as R2Bucket;
  const unavailable = () => { throw new Error('Internal binding not available in storage-only tests'); };
  const env = { NEBIUS_API_KEY: 'test-transport-only-not-a-real-key', DB: db, CACHE: cache, FILES: bucket, EVENTS: { send: async () => undefined },
    AGENT: { idFromName: (name: string) => name, get: () => ({ fetch: unavailable }) },
    PACK_RUN: { create: unavailable }, INTAKE: { create: unavailable }, SCAN: { create: unavailable } } as unknown as Env;
  return { env, dispose: async () => sqlite.close() };
}
