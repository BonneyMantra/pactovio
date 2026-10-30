import { newId, type AgentMessage, type AgentThread, type PendingAction } from '@pactovio/contracts';

/** The slice of Durable Object `SqlStorage` the hub uses (tests plug node:sqlite in behind the same shape). */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[]; readonly rowsWritten?: number };
}

export type ThreadRow = AgentThread & { session_id: string | null; kind: string };
export const INBOX_THREAD = 'thr_inbox';

export interface ActionRow extends PendingAction {
  thread_id: string | null;
  session_id: string | null;
  event_id: string | null;
  created_at: string;
  decided_at: string | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls_json TEXT, action_id TEXT, event_type TEXT, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq)`,
  `CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, thread_id TEXT, session_id TEXT, tool TEXT NOT NULL, input_json TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, event_id TEXT, created_at TEXT NOT NULL, decided_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS turn_log (session_id TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_log ON turn_log(session_id, at)`,
  `CREATE TABLE IF NOT EXISTS usage (session_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS seen_events (event_id TEXT PRIMARY KEY, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sent_keys (key TEXT PRIMARY KEY, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

type Row = Record<string, unknown>;
const j = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const p = <T>(v: unknown): T | undefined => {
  if (typeof v !== 'string') return undefined;
  try { return JSON.parse(v) as T; } catch { return undefined; }
};

/** All SQLite access of the AgentHub. One instance per Durable Object. */
export class HubStore {
  constructor(private readonly sql: SqlLike, private readonly clock: () => number = Date.now) {
    for (const s of SCHEMA) this.sql.exec(s);
  }
  private q(query: string, ...b: unknown[]): Row[] { return this.sql.exec(query, ...b).toArray(); }
  private run(query: string, ...b: unknown[]): number {
    const c = this.sql.exec(query, ...b);
    c.toArray();
    return c.rowsWritten ?? 0;
  }
  private iso() { return new Date(this.clock()).toISOString(); }

  getKv(key: string): string | undefined { return this.q('SELECT value FROM kv WHERE key = ?', key)[0]?.value as string | undefined; }
  setKv(key: string, value: string): void { this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  // threads
  ensureInbox(): ThreadRow {
    const now = this.iso();
    this.run("INSERT OR IGNORE INTO threads (id, session_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'inbox', 'Pactovio inbox', ?, ?)", INBOX_THREAD, now, now);
    return this.getThread(INBOX_THREAD)!;
  }
  createThread(sessionKey: string, title: string): ThreadRow {
    const id = newId('thread');
    const now = this.iso();
    this.run("INSERT INTO threads (id, session_id, kind, title, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?, ?)", id, sessionKey, title.slice(0, 80) || 'New chat', now, now);
    return this.getThread(id)!;
  }
  getThread(id: string): ThreadRow | undefined {
    const r = this.q('SELECT * FROM threads WHERE id = ?', id)[0];
    return r ? { id: r.id as string, title: r.title as string, created_at: r.created_at as string, updated_at: r.updated_at as string, session_id: r.session_id as string | null, kind: r.kind as string } : undefined;
  }
  /** The workspace inbox first, then this session's chats, newest first. */
  listThreads(sessionKey: string): AgentThread[] {
    return this.q("SELECT * FROM threads WHERE kind = 'inbox' OR session_id = ? ORDER BY (kind = 'inbox') DESC, updated_at DESC LIMIT 50", sessionKey)
      .map((r) => ({ id: r.id as string, title: r.title as string, created_at: r.created_at as string, updated_at: r.updated_at as string }));
  }
  canSee(threadId: string, sessionKey: string): boolean {
    const t = this.getThread(threadId);
    return !!t && (t.kind === 'inbox' || t.session_id === sessionKey);
  }

  // messages
  addMessage(m: { thread_id: string; role: AgentMessage['role']; content: string; tool_calls?: AgentMessage['tool_calls']; action_id?: string; event_type?: string }): AgentMessage {
    const id = newId('message');
    const at = this.iso();
    this.run('INSERT INTO messages (id, thread_id, role, content, tool_calls_json, action_id, event_type, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, m.thread_id, m.role, m.content, j(m.tool_calls), m.action_id ?? null, m.event_type ?? null, at);
    this.run('UPDATE threads SET updated_at = ? WHERE id = ?', at, m.thread_id);
    return this.toMessage(this.q('SELECT * FROM messages WHERE id = ?', id)[0]!);
  }
  listMessages(threadId: string, limit = 100): AgentMessage[] {
    return this.q('SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', threadId, limit).map((r) => this.toMessage(r));
  }
  /** Inbox messages newer than `sinceId` (all of them when unknown), oldest first. */
  inboxSince(sinceId: string | undefined, limit = 50): (AgentMessage & { event_type: string | null })[] {
    const seq = sinceId ? (this.q('SELECT seq FROM messages WHERE id = ?', sinceId)[0]?.seq as number | undefined) : undefined;
    if (sinceId && seq === undefined) return [];
    return this.q('SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?', INBOX_THREAD, seq ?? 0, limit)
      .map((r) => ({ ...this.toMessage(r), event_type: (r.event_type as string | null) ?? null }));
  }
  private toMessage(r: Row): AgentMessage {
    const action = r.action_id ? this.getAction(r.action_id as string) : undefined;
    return {
      id: r.id as string, thread_id: r.thread_id as string, role: r.role as AgentMessage['role'], content: r.content as string, at: r.at as string,
      ...(r.tool_calls_json ? { tool_calls: p<AgentMessage['tool_calls']>(r.tool_calls_json) } : {}),
      ...(action ? { pending_action: toPending(action) } : {}),
    };
  }

  // actions
  createAction(a: { thread_id: string | null; session_id: string | null; tool: string; input: Record<string, unknown>; title: string; detail: string; summary: string; source: NonNullable<PendingAction['source']>; event_id?: string }): ActionRow {
    const id = newId('action');
    this.run("INSERT INTO actions (id, thread_id, session_id, tool, input_json, title, detail, summary, source, status, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      id, a.thread_id, a.session_id, a.tool, JSON.stringify(a.input), a.title, a.detail, a.summary, a.source, a.event_id ?? null, this.iso());
    return this.getAction(id)!;
  }
  getAction(id: string): ActionRow | undefined {
    const r = this.q('SELECT * FROM actions WHERE id = ?', id)[0];
    if (!r) return undefined;
    return {
      id: r.id as string, tool: r.tool as string, input: p<Record<string, unknown>>(r.input_json) ?? {}, summary: r.summary as string, title: r.title as string, detail: r.detail as string,
      status: r.status as PendingAction['status'], source: r.source as PendingAction['source'], result: p(r.result_json),
      thread_id: r.thread_id as string | null, session_id: r.session_id as string | null, event_id: r.event_id as string | null, created_at: r.created_at as string, decided_at: r.decided_at as string | null,
    };
  }
  /** Atomic: only a `pending` action can move. Returns false when someone else already decided it. */
  claimAction(id: string, to: 'confirmed' | 'declined'): boolean {
    return this.run("UPDATE actions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'", to, this.iso(), id) > 0;
  }
  finishAction(id: string, status: 'executed' | 'failed', result: unknown): void {
    this.run('UPDATE actions SET status = ?, result_json = ? WHERE id = ?', status, j(result), id);
  }

  // caps
  turnStamps(sessionKey: string, since: number): number[] {
    return this.q('SELECT at FROM turn_log WHERE session_id = ? AND at > ?', sessionKey, since).map((r) => r.at as number);
  }
  logTurn(sessionKey: string): void {
    const now = this.clock();
    this.run('INSERT INTO turn_log (session_id, at) VALUES (?, ?)', sessionKey, now);
    this.run('DELETE FROM turn_log WHERE at < ?', now - 3_600_000);
  }
  usage(sessionKey: string): { tokens: number; cost_usd: number; turns: number } {
    const r = this.q('SELECT tokens, cost_usd, turns FROM usage WHERE session_id = ?', sessionKey)[0];
    return { tokens: (r?.tokens as number) ?? 0, cost_usd: (r?.cost_usd as number) ?? 0, turns: (r?.turns as number) ?? 0 };
  }
  addUsage(sessionKey: string, tokens: number, costUsd: number): void {
    this.run('INSERT INTO usage (session_id, tokens, cost_usd, turns) VALUES (?, ?, ?, 1) ON CONFLICT(session_id) DO UPDATE SET tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd, turns = turns + 1', sessionKey, tokens, costUsd);
  }

  // dedupe
  /** true the first time an event id is seen. */
  markEvent(eventId: string): boolean {
    const w = this.run('INSERT OR IGNORE INTO seen_events (event_id, at) VALUES (?, ?)', eventId, this.iso());
    this.run('DELETE FROM seen_events WHERE at < ?', new Date(this.clock() - 7 * 86_400_000).toISOString());
    return w > 0;
  }
  sentKeys(): Set<string> { return new Set(this.q('SELECT key FROM sent_keys').map((r) => r.key as string)); }
  markSent(key: string): void { this.run('INSERT OR IGNORE INTO sent_keys (key, at) VALUES (?, ?)', key, this.iso()); }
}

export function toPending(a: ActionRow): PendingAction {
  return { id: a.id, tool: a.tool, input: a.input, summary: a.summary, status: a.status, title: a.title, detail: a.detail, source: a.source, ...(a.result !== undefined ? { result: a.result } : {}) };
}
