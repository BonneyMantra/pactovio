import { fromRow } from '@pactovio/contracts';

export async function rows<T = Record<string, unknown>>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return res.results.map((r) => fromRow<T>(r));
}

export async function one<T = Record<string, unknown>>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  const r = await db.prepare(sql).bind(...binds).first<Record<string, unknown>>();
  return r ? fromRow<T>(r) : null;
}

export async function exec(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...binds).run();
}

export const nowIso = () => new Date().toISOString();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
