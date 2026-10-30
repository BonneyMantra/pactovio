import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';

const startPackRun = vi.fn(async () => 'run_test_1');
const createQuote = vi.fn(async () => ({ id: 'quo_1', status: 'draft', currency: 'EUR', total_minor: 123456, lines: [], valid_until: null }));
const runAction = vi.fn(async () => ({ ok: true }));
vi.mock('@pactovio/engine', () => ({ startPackRun, draftAnswers: vi.fn(), buyerIntel: vi.fn() }));
vi.mock('@pactovio/quote', () => ({ createQuote, matchDesignRequest: vi.fn() }));
vi.mock('@pactovio/connectors', () => ({ runAction }));
vi.mock('@pactovio/billing', () => ({ getPlan: vi.fn() }));

const { agentTools, getTool, invokeTool, requiresConfirmation, toolJsonSchema } = await import('../src');

/** D1 fake: every query returns the row configured for a SQL fragment, else nothing. */
function fakeEnv(rows: Record<string, unknown> = {}): Env {
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => Object.entries(rows).find(([k]) => sql.includes(k))?.[1] ?? null,
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
    }),
  };
  return { DB: db } as unknown as Env;
}

const EXPECTED = ['list_today', 'search_tenders', 'get_tender', 'start_pack_run', 'get_matrix', 'get_verdicts', 'draft_answers', 'approve_answer', 'buyer_intel', 'list_intakes', 'create_design_request_from_text', 'match_design_request', 'create_quote', 'list_connectors', 'run_connector_action', 'billing_status', 'get_limits'];

describe('tool registry', () => {
  it('exposes exactly the 17 contracted tools with unique names', () => {
    expect(agentTools.map((t) => t.name)).toEqual(EXPECTED);
    expect(new Set(agentTools.map((t) => t.name)).size).toBe(EXPECTED.length);
  });
  it.each(agentTools.map((t) => [t.name, t] as const))('%s has a zod input, a description and a JSON schema object', (_n, t) => {
    expect(t.input).toBeInstanceOf(z.ZodType);
    expect(t.description.length).toBeGreaterThan(30);
    const js = toolJsonSchema(t) as { type?: string; properties?: Record<string, unknown> };
    expect(js.type).toBe('object');
  });
  it('required inputs are enforced by the schemas', () => {
    expect(getTool('get_tender')!.input.safeParse({}).success).toBe(false);
    expect(getTool('approve_answer')!.input.safeParse({ answer_id: 'x' }).success).toBe(false); // too short to be an id
    expect(getTool('create_quote')!.input.safeParse({ qty: 0 }).success).toBe(false);
    expect(getTool('search_tenders')!.input.safeParse({ limit: 500 }).success).toBe(false);
  });
  it('read tools are not mutating; everything that changes state or reaches outside is', () => {
    const mutating = agentTools.filter((t) => t.mutating).map((t) => t.name).sort();
    expect(mutating).toEqual(['approve_answer', 'create_design_request_from_text', 'create_quote', 'draft_answers', 'match_design_request', 'run_connector_action', 'start_pack_run']);
  });
  it('buyer_intel only needs confirmation when it refreshes through Tavily', () => {
    const t = getTool('buyer_intel')!;
    expect(requiresConfirmation(t, { refresh: false })).toBe(false);
    expect(requiresConfirmation(t, { refresh: true })).toBe(true);
  });
});

describe('confirmation gating', () => {
  beforeEach(() => vi.clearAllMocks());
  const ctx = { workspaceId: 'ws_harbour_digital', sessionId: 'ses_1', source: 'chat' as const };

  it('a mutating tool returns a pending action and does NOT execute', async () => {
    const env = fakeEnv({ 'FROM tenders WHERE id': { title: 'Teagasc web applications maintenance' } });
    const out = await invokeTool(env, ctx, 'start_pack_run', { tender_id: 'tnd_sample_teagasc_p4941' });
    expect(out.status).toBe('pending');
    if (out.status !== 'pending') return;
    expect(out.tool).toBe('start_pack_run');
    expect(out.title).toBe('Read the pack?');
    expect(out.detail).toContain('Teagasc');
    expect(startPackRun).not.toHaveBeenCalled();
  });
  it.each([
    ['create_quote', { design_request_id: 'dsg_sample_1' }, createQuote],
    ['run_connector_action', { provider: 'slack', action: 'post_message', input: { text: 'hi' } }, runAction],
  ] as const)('%s never executes without confirmation', async (name, input, spy) => {
    const out = await invokeTool(fakeEnv(), ctx, name, input);
    expect(out.status).toBe('pending');
    expect(spy).not.toHaveBeenCalled();
  });
  it('the model-facing path cannot self-confirm: ctx.confirmed is the only switch and the input cannot set it', async () => {
    const out = await invokeTool(fakeEnv({ 'FROM tenders WHERE id': { id: 'tnd_1', title: 't', buyer: 'b', buyer_key: 'b', deadline: null } }), ctx, 'start_pack_run', { tender_id: 'tnd_sample_teagasc_p4941', confirmed: true, replay: false });
    expect(out.status).toBe('pending');
    expect(startPackRun).not.toHaveBeenCalled();
  });
  it('after confirmation (ctx.confirmed) the tool runs', async () => {
    const env = fakeEnv({ 'FROM tenders WHERE id': { id: 'tnd_1', title: 't', buyer: 'b', buyer_key: 'b', deadline: null } });
    const out = await invokeTool(env, { ...ctx, confirmed: true }, 'start_pack_run', { tender_id: 'tnd_sample_teagasc_p4941' });
    expect(out).toEqual({ status: 'ok', result: { run_id: 'run_test_1', tender_id: 'tnd_sample_teagasc_p4941', replay: false } });
    expect(startPackRun).toHaveBeenCalledOnce();
  });
  it('bad input is a validation error, unknown tool is an error, neither executes', async () => {
    const bad = await invokeTool(fakeEnv(), { ...ctx, confirmed: true }, 'start_pack_run', {});
    expect(bad).toMatchObject({ status: 'error', code: 'validation' });
    expect(await invokeTool(fakeEnv(), ctx, 'drop_database', {})).toMatchObject({ status: 'error', code: 'unknown_tool' });
    expect(startPackRun).not.toHaveBeenCalled();
  });
  it('a missing tender is a not_found error the model can read', async () => {
    const out = await invokeTool(fakeEnv(), { ...ctx, confirmed: true }, 'start_pack_run', { tender_id: 'tnd_nope' });
    expect(out).toMatchObject({ status: 'error', code: 'not_found' });
  });
  it('a connector that is not connected is refused even after confirmation', async () => {
    const out = await invokeTool(fakeEnv(), { ...ctx, confirmed: true }, 'run_connector_action', { provider: 'slack', action: 'post_message' });
    expect(out).toMatchObject({ status: 'error', code: 'not_connected' });
    expect(runAction).not.toHaveBeenCalled();
  });
  it('read tools run immediately', async () => {
    const out = await invokeTool(fakeEnv(), ctx, 'list_connectors', {});
    expect(out).toEqual({ status: 'ok', result: { count: 0, items: [] } });
  });
});
