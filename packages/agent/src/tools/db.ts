import { fromRow } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export async function rows<T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return res.results.map((r) => fromRow<T>(r));
}

export async function one<T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  const r = await env.DB.prepare(sql).bind(...binds).first<Record<string, unknown>>();
  return r ? fromRow<T>(r) : null;
}

export async function exec(env: Env, sql: string, ...binds: unknown[]): Promise<void> {
  await env.DB.prepare(sql).bind(...binds).run();
}

/** Tool failures the model should see as data, not crashes. */
export class ToolError extends Error {
  constructor(message: string, readonly code = 'tool_error') {
    super(message);
  }
}

export async function requireTender(env: Env, tenderId: string) {
  const t = await one<{ id: string; title: string; buyer: string; buyer_key: string; deadline: string | null }>(
    env, 'SELECT id, title, buyer, buyer_key, deadline FROM tenders WHERE id = ?', tenderId,
  );
  if (!t) throw new ToolError(`No tender with id ${tenderId}`, 'not_found');
  return t;
}
