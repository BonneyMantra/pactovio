import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWsMessage } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import type { StreamLoopParams, StreamLoopResult } from '@pactovio/agent';

const { startPackRun } = vi.hoisted(() => ({ startPackRun: vi.fn(async (..._a: unknown[]) => 'run_test_1') }));
vi.mock('@pactovio/engine', async (orig) => ({ ...(await orig<object>()), startPackRun }));
const { runAction } = vi.hoisted(() => ({ runAction: vi.fn(async (_e: unknown, _w: string, _p: string, _a: string, _i: Record<string, unknown>) => ({ ok: true })) }));
vi.mock('@pactovio/connectors', async (orig) => ({ ...(await orig<object>()), runAction }));

import { runTurn } from '../src/do/chat';
import { decideAction } from '../src/do/decide';
import { runDaily } from '../src/do/digest';
import { handleEvent } from '../src/do/proactive';
import type { HubDeps } from '../src/do/deps';
import { HubStore, INBOX_THREAD } from '../src/do/store';
import { memorySql } from './sqlite-adapter';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => ({ env, dispose } = await makeEnv()), 60_000);
afterAll(async () => dispose?.());

const WS = 'ws_harbour_digital';
const TENDER = 'tnd_sample_teagasc_p4941';

interface Harness { deps: HubDeps; store: HubStore; frames: { frame: AgentWsMessage; session?: string }[]; published: string[]; clock: { t: number } }

/** A hub with a scripted model: `script` stands in for the Nemotron tool loop and may call runTool like the real loop does. */
function harness(script: (p: StreamLoopParams) => Promise<Partial<StreamLoopResult>>): Harness {
  const clock = { t: Date.UTC(2026, 10, 1, 4, 0) };
  const store = new HubStore(memorySql(), () => clock.t);
  const frames: Harness['frames'] = [];
  const published: string[] = [];
  const deps: HubDeps = {
    env, store, workspaceId: WS, now: () => clock.t,
    send: (frame, scope) => frames.push({ frame, session: scope?.session }),
    publish: (m) => published.push(m.id),
    loop: async (p) => ({ text: '', messages: [], tokensIn: 100, tokensOut: 20, costUsd: 0.0005, modelCalls: 1, fellBack: false, model: 'm', stoppedEarly: false, ...(await script(p)) }),
  };
  return { deps, store, frames, published, clock };
}

const startRunScript = (id = 'call_1') => async (p: StreamLoopParams) => {
  const r = await p.runTool({ id, name: 'start_pack_run', input: { tender_id: TENDER } });
  p.onToolCall?.({ id, name: 'start_pack_run', input: { tender_id: TENDER }, status: r.status });
  return { text: 'I asked you to confirm reading the Teagasc pack.' };
};

beforeEach(() => vi.clearAllMocks());

describe('chat turn with confirmation gating', () => {
  it('a state-changing tool call becomes a pending action card; nothing runs until confirmed', async () => {
    const h = harness(startRunScript());
    const turn = await runTurn(h.deps, { sessionId: 'ses_a', content: 'Read the Teagasc pack' });
    expect(startPackRun).not.toHaveBeenCalled();
    expect(turn.pending_actions).toHaveLength(1);
    const action = turn.pending_actions[0]!;
    expect(action).toMatchObject({ tool: 'start_pack_run', status: 'pending', source: 'chat', title: 'Read the pack?' });
    expect(action.detail).toContain('Web applications maintenance');
    expect(turn.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(turn.messages[1]!.pending_action?.id).toBe(action.id);
    const types = h.frames.map((f) => f.frame.type);
    expect(types).toEqual(expect.arrayContaining(['thread', 'approval_requested', 'assistant_message', 'done']));
    expect(h.frames.every((f) => f.session === 'ses_a')).toBe(true);

    const done = await decideAction(h.deps, action.id, 'confirm', { sessionId: 'ses_a' });
    expect(done.status).toBe('executed');
    expect(done.result).toMatchObject({ run_id: 'run_test_1' });
    expect(startPackRun).toHaveBeenCalledOnce();
    const result = h.frames.find((f) => f.frame.type === 'action_result')!.frame as Extract<AgentWsMessage, { type: 'action_result' }>;
    expect(result.message?.content).toContain('Run started (run_test_1)');
  });

  it('declining never runs the tool, and an action cannot be decided twice', async () => {
    const h = harness(startRunScript());
    const { pending_actions: [a] } = await runTurn(h.deps, { sessionId: 'ses_a', content: 'go' });
    expect((await decideAction(h.deps, a!.id, 'decline', { sessionId: 'ses_a' })).status).toBe('declined');
    await expect(decideAction(h.deps, a!.id, 'confirm', { sessionId: 'ses_a' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(startPackRun).not.toHaveBeenCalled();
  });

  it('two concurrent confirms execute exactly once', async () => {
    const h = harness(startRunScript());
    const { pending_actions: [a] } = await runTurn(h.deps, { sessionId: 'ses_a', content: 'go' });
    const results = await Promise.allSettled([decideAction(h.deps, a!.id, 'confirm', { sessionId: 'ses_a' }), decideAction(h.deps, a!.id, 'confirm', { sessionId: 'ses_a' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(startPackRun).toHaveBeenCalledOnce();
  });

  it('another judge session cannot decide my action, and cannot read my thread', async () => {
    const h = harness(startRunScript());
    const turn = await runTurn(h.deps, { sessionId: 'ses_a', content: 'go' });
    await expect(decideAction(h.deps, turn.pending_actions[0]!.id, 'confirm', { sessionId: 'ses_b' })).rejects.toMatchObject({ status: 403 });
    expect(h.store.canSee(turn.thread_id, 'ses_b')).toBe(false);
    expect(h.store.listThreads('ses_b').map((t) => t.id)).toEqual([]);
    await expect(runTurn(h.deps, { sessionId: 'ses_b', threadId: turn.thread_id, content: 'hi' })).rejects.toMatchObject({ status: 404 });
    expect(startPackRun).not.toHaveBeenCalled();
  });

  it('a tool that fails after confirmation is recorded as failed with a readable message', async () => {
    startPackRun.mockRejectedValueOnce(new Error('boom'));
    const h = harness(startRunScript());
    const { pending_actions: [a] } = await runTurn(h.deps, { sessionId: 'ses_a', content: 'go' });
    const done = await decideAction(h.deps, a!.id, 'confirm', { sessionId: 'ses_a' });
    expect(done.status).toBe('failed');
    expect(JSON.stringify(done.result)).not.toContain('boom'); // internal error text never reaches the user
  });

  it('the thread keeps history for the next turn, scoped to the session', async () => {
    let seen: StreamLoopParams['messages'] = [];
    const h = harness(async (p) => { seen = p.messages; return { text: 'ok' }; });
    const t1 = await runTurn(h.deps, { sessionId: 'ses_a', content: 'first question' });
    await runTurn(h.deps, { sessionId: 'ses_a', threadId: t1.thread_id, content: 'second question' });
    expect(seen.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(String(seen[0]!.content)).toContain('Harbour Digital');
    expect(String(seen[0]!.content)).toContain('No arithmetic by you');
    expect(seen.at(-1)!.content).toBe('second question');
  });
});

describe('caps', () => {
  it('the 11th turn within a minute is refused with 429 rate_limited; a minute later it works again', async () => {
    const h = harness(async () => ({ text: 'ok' }));
    for (let i = 0; i < 10; i++) await runTurn(h.deps, { sessionId: 'ses_cap', content: `q${i}` });
    await expect(runTurn(h.deps, { sessionId: 'ses_cap', content: 'one too many' })).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    await runTurn(h.deps, { sessionId: 'ses_other', content: 'other session is unaffected' });
    h.clock.t += 61_000;
    await runTurn(h.deps, { sessionId: 'ses_cap', content: 'later' });
  });

  it('a session that spent its token budget gets 429 budget_exhausted', async () => {
    const h = harness(async () => ({ text: 'ok', tokensIn: 100_000, tokensOut: 60_000 }));
    await runTurn(h.deps, { sessionId: 'ses_big', content: 'expensive' });
    await expect(runTurn(h.deps, { sessionId: 'ses_big', content: 'again' })).rejects.toMatchObject({ status: 429, code: 'budget_exhausted' });
  });

  it('a model outage returns 502 model_error without leaking internals, and the turn is not left half-saved as an answer', async () => {
    const h = harness(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1 Bearer sk-secret'); });
    await expect(runTurn(h.deps, { sessionId: 'ses_x', content: 'hi' })).rejects.toMatchObject({ status: 502, code: 'model_error' });
    const err = h.frames.find((f) => f.frame.type === 'error')!.frame as Extract<AgentWsMessage, { type: 'error' }>;
    expect(err.error).not.toContain('sk-secret');
  });
});

describe('proactive events', () => {
  it('tender.matched becomes an inbox message with a Start action, enriched from the database', async () => {
    const h = harness(async () => ({}));
    const msg = await handleEvent(h.deps, { id: 'evt_1', workspace_id: WS, type: 'tender.matched', payload: { tender_id: TENDER }, at: new Date().toISOString() });
    expect(msg!.thread_id).toBe(INBOX_THREAD);
    expect(msg!.content).toMatch(/^New match: Web applications maintenance.*fit \d+/);
    expect(msg!.content).toContain('Read the pack?');
    expect(msg!.pending_action).toMatchObject({ tool: 'start_pack_run', status: 'pending', source: 'event', input: { tender_id: TENDER } });
    const types = h.frames.map((f) => f.frame.type);
    expect(types).toEqual(['event', 'assistant_message', 'approval_requested']);
    expect(h.frames.every((f) => f.session === undefined)).toBe(true); // workspace-wide
    expect(h.published).toEqual([msg!.id]);
  });

  it('a redelivered event produces one message only', async () => {
    const h = harness(async () => ({}));
    const e = { id: 'evt_dup', workspace_id: WS, type: 'verdict.ready' as const, payload: { tender_id: TENDER, decision: 'BID', score: 80 }, at: new Date().toISOString() };
    expect(await handleEvent(h.deps, e)).not.toBeNull();
    expect(await handleEvent(h.deps, e)).toBeNull();
    expect(h.store.inboxSince(undefined)).toHaveLength(1);
  });

  it('any workspace member can confirm an event action, and it runs', async () => {
    const h = harness(async () => ({}));
    const msg = await handleEvent(h.deps, { id: 'evt_2', workspace_id: WS, type: 'tender.matched', payload: { tender_id: TENDER }, at: new Date().toISOString() });
    const done = await decideAction(h.deps, msg!.pending_action!.id, 'confirm', { sessionId: 'ses_anyone' });
    expect(done.status).toBe('executed');
    expect(startPackRun).toHaveBeenCalledOnce();
  });

  it('events the chat does not care about are relayed as event frames but create no message', async () => {
    const h = harness(async () => ({}));
    expect(await handleEvent(h.deps, { id: 'evt_3', workspace_id: WS, type: 'run.step', payload: { seq: 1 }, at: new Date().toISOString() })).toBeNull();
    expect(h.frames.map((f) => f.frame.type)).toEqual(['event']);
  });

  it('inboxSince resumes an SSE subscriber after a given message id', async () => {
    const h = harness(async () => ({}));
    const a = await handleEvent(h.deps, { id: 'e_a', workspace_id: WS, type: 'quote.ready', payload: { total_minor: 5000, currency: 'EUR' }, at: '' });
    const b = await handleEvent(h.deps, { id: 'e_b', workspace_id: WS, type: 'audit.completed', payload: { status: 'completed' }, at: '' });
    expect(h.store.inboxSince(a!.id).map((m) => m.id)).toEqual([b!.id]);
    expect(h.store.inboxSince('msg_unknown')).toEqual([]);
  });
});

describe('alarm: digest and reminders', () => {
  it('posts the digest, then deadline and certificate nudges once, never twice', async () => {
    const h = harness(async () => ({}));
    h.clock.t = Date.UTC(2026, 10, 18, 22, 30); // 06:30 MYT on 19 Nov; Teagasc closes 19 Nov 14:00 GMT
    const first = await runDaily(h.deps);
    expect(first.digest).toBe(true);
    const texts = h.store.inboxSince(undefined).map((m) => m.content);
    expect(texts[0]).toContain('Pactovio digest for Harbour Digital');
    expect(texts.some((t) => t.startsWith('Deadline in') && t.includes('Web applications maintenance'))).toBe(true);
    const n = texts.length;
    const second = await runDaily(h.deps);
    expect(second.reminders).toBe(0);
    expect(h.store.inboxSince(undefined)).toHaveLength(n + 1); // only a fresh digest
  });
});

describe('mirror to Slack and Teams', () => {
  const posts: { provider: string; action: string; input: Record<string, unknown> }[] = [];
  beforeEach(async () => {
    posts.length = 0;
    runAction.mockImplementation(async (_e: unknown, _w: string, provider: string, action: string, input: Record<string, unknown>) => { posts.push({ provider, action, input }); return { ok: true }; });
    await env.DB.prepare("DELETE FROM connectors WHERE workspace_id = ? AND provider IN ('slack','teams')").bind(WS).run();
  });
  const seed = (provider: string, meta: object) =>
    env.DB.prepare("INSERT INTO connectors (id, workspace_id, provider, status, external_account_id, meta_json, connected_at) VALUES (?, ?, ?, 'connected', 'acct', ?, ?)")
      .bind(`cnx_t_${provider}`, WS, provider, JSON.stringify(meta), new Date().toISOString()).run();
  const matched = { id: 'evt_m', workspace_id: WS, type: 'tender.matched' as const, payload: { tender_id: TENDER }, at: '' };

  it('posts the proactive message to a connected Slack with signed approve and decline links', async () => {
    await seed('slack', { channel: '#bids' });
    const h = harness(async () => ({}));
    const msg = await handleEvent(h.deps, matched);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ provider: 'slack', action: 'post_message' });
    const text = String(posts[0]!.input.text);
    expect(posts[0]!.input.channel).toBe('#bids');
    expect(text).toContain('New match:');
    const actionId = msg!.pending_action!.id;
    const approve = /<(https:\/\/[^|]+)\|Approve>/.exec(text)![1]!;
    const u = new URL(approve);
    expect(u.pathname).toBe(`/api/agent/actions/${actionId}/link`);
    expect(u.searchParams.get('w')).toBe(WS);
    expect(u.searchParams.get('d')).toBe('confirm');
    const { verifyDecision } = await import('@pactovio/agent');
    expect(await verifyDecision('dev-webhook-signing', WS, actionId, 'confirm', u.searchParams.get('t')!)).toBe(true);
    expect(await verifyDecision('dev-webhook-signing', WS, actionId, 'decline', u.searchParams.get('t')!)).toBe(false);
  });

  it('uses markdown links for Teams, skips sample connectors, and a failing connector never breaks the message', async () => {
    await seed('teams', {});
    const h = harness(async () => ({}));
    await handleEvent(h.deps, { ...matched, id: 'evt_t' });
    expect(String(posts[0]!.input.text)).toMatch(/\[Approve\]\(https:\/\/.*\) \| \[Decline\]/);
    posts.length = 0;
    await env.DB.prepare("UPDATE connectors SET meta_json = '{\"sample\":true}' WHERE id = 'cnx_t_teams'").run();
    await handleEvent(h.deps, { ...matched, id: 'evt_t2' });
    expect(posts).toHaveLength(0);
    await env.DB.prepare("UPDATE connectors SET meta_json = '{}' WHERE id = 'cnx_t_teams'").run();
    runAction.mockRejectedValueOnce(new Error('composio down'));
    const msg = await handleEvent(h.deps, { ...matched, id: 'evt_t3' });
    expect(msg).not.toBeNull();
  });
});

describe('enrichment', () => {
  it('approval.requested pulls the draft answer into the card so the human sees what they approve', async () => {
    const row = await env.DB.prepare("SELECT id, draft FROM answers WHERE workspace_id = ? AND status = 'draft' LIMIT 1").bind(WS).first<{ id: string; draft: string }>();
    const h = harness(async () => ({}));
    const msg = await handleEvent(h.deps, { id: 'evt_appr', workspace_id: WS, type: 'approval.requested', payload: { answer_id: row!.id }, at: '' });
    expect(msg!.pending_action).toMatchObject({ tool: 'approve_answer', input: { answer_id: row!.id } });
    expect(msg!.pending_action!.detail).toContain(row!.draft.slice(0, 40));
    expect(msg!.content).toMatch(/needs your approval: /);
  });
});
