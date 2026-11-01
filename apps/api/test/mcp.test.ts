import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';

const { startPackRun } = vi.hoisted(() => ({ startPackRun: vi.fn(async (..._a: unknown[]) => 'run_test_1') }));
vi.mock('@pactovio/engine', async (orig) => ({ ...(await orig<object>()), startPackRun }));

import { agentTools } from '@pactovio/agent';
import { buildApp } from '../src/app';
import { sha256Hex } from '../src/lib/db';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const KEY = 'pk_mcptest0123456789abcdef';
const hubCalls: { path: string; body: Record<string, unknown> }[] = [];
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  await customerFixture(env, 'ws_harbour_digital');
  await customerFixture(env, 'ws_kestrel_sensing');
  await env.DB.prepare('INSERT INTO api_keys (id, workspace_id, prefix, hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind('key_mcptest', 'ws_harbour_digital', KEY.slice(0, 11), await sha256Hex(KEY), 'mcp test', new Date().toISOString()).run();
  // The Durable Object is not available outside wrangler dev: a stand-in records what MCP forwards to the hub.
  env = {
    ...env,
    AGENT: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          hubCalls.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
          return Response.json({ id: 'act_mcp_1', tool: 'start_pack_run', input: {}, summary: 's', status: 'pending', source: 'mcp' });
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
}, 60_000);
afterAll(async () => dispose?.());

const rpc = (body: unknown, key: string | null = KEY) =>
  app.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }), env, ctx);
const call = async (method: string, params?: unknown, id: number | string = 1) => (await (await rpc({ jsonrpc: '2.0', id, method, params })).json()) as { id: unknown; result?: any; error?: { code: number; message: string } };

describe('MCP /mcp: auth', () => {
  it('rejects a missing, malformed or unknown API key with 401 { error, code } and a challenge header', async () => {
    for (const k of [null, 'pk_nonsense', 'Bearer-less']) {
      const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, k);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('unauthorized');
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
  });
  it('GET and DELETE are 405 (this server has no SSE stream or sessions)', async () => {
    expect((await app.fetch(new Request('http://localhost/mcp'), env, ctx)).status).toBe(405);
    expect((await app.fetch(new Request('http://localhost/mcp', { method: 'DELETE' }), env, ctx)).status).toBe(405);
  });
});

describe('MCP /mcp: protocol round trip', () => {
  it('initialize negotiates the protocol version and advertises tools', async () => {
    const r = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe('pactovio');
    expect((await call('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-06-18');
  });
  it('a notification gets 202 and no body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
  it('tools/list returns the same 17 agent tools with JSON schemas and read-only hints', async () => {
    const r = await call('tools/list');
    const tools = r.result.tools as { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(agentTools.map((t) => t.name));
    expect(tools).toHaveLength(17);
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(tools.find((t) => t.name === 'list_today')!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'start_pack_run')!.annotations.readOnlyHint).toBe(false);
  });
  it('tools/call runs a read tool against the workspace data', async () => {
    const r = await call('tools/call', { name: 'search_tenders', arguments: { q: 'Web applications', limit: 3 } });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent.count).toBeGreaterThan(0);
    expect(r.result.structuredContent.items[0].tender_id).toBe('tnd_sample_teagasc_p4941');
    expect(JSON.parse(r.result.content[0].text).count).toBe(r.result.structuredContent.count);
    const m = await call('tools/call', { name: 'get_matrix', arguments: { tender_id: 'tnd_sample_teagasc_p4941', status: 'GAP' } });
    expect(m.result.structuredContent.requirements.every((q: { status: string }) => q.status === 'GAP')).toBe(true);
  });
  it('a state-changing tool returns a pending action, is forwarded to the hub, and never executes', async () => {
    hubCalls.length = 0;
    const r = await call('tools/call', { name: 'start_pack_run', arguments: { tender_id: 'tnd_sample_teagasc_p4941' } });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent).toMatchObject({ status: 'pending_confirmation', action_id: 'act_mcp_1', title: 'Read the pack?' });
    expect(startPackRun).not.toHaveBeenCalled();
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0]).toMatchObject({ path: '/pending', body: { tool: 'start_pack_run', input: { tender_id: 'tnd_sample_teagasc_p4941', replay: false } } });
  });
  it('tool errors are results with isError, not protocol errors', async () => {
    const bad = await call('tools/call', { name: 'get_tender', arguments: {} });
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0].text).code).toBe('validation');
    const missing = await call('tools/call', { name: 'get_tender', arguments: { tender_id: 'tnd_missing' } });
    expect(JSON.parse(missing.result.content[0].text).code).toBe('not_found');
  });
  it('JSON-RPC errors: unknown tool and method, bad params, bad request, parse error', async () => {
    expect((await call('tools/call', { name: 'nope', arguments: {} })).error?.code).toBe(-32602);
    expect((await call('tools/call', { arguments: {} })).error?.code).toBe(-32602);
    expect((await call('resources/list')).error?.code).toBe(-32601);
    const invalid = (await (await rpc({ hello: 'world' })).json()) as { error: { code: number } };
    expect(invalid.error.code).toBe(-32600);
    const parse = await app.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: '{not json' }), env, ctx);
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
  it('ping and batches work; a batch of notifications is 202', async () => {
    expect((await call('ping')).result).toEqual({});
    const batch = (await (await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])).json()) as { id: number }[];
    expect(batch.map((b) => b.id)).toEqual([1, 2]);
    expect((await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }])).status).toBe(202);
  });
  it('an API key only sees its own workspace', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO api_keys (id, workspace_id, prefix, hash, name, created_at) VALUES ('key_k', 'ws_kestrel_sensing', 'pk_kestrel0', ?, 'k', ?)")
      .bind(await sha256Hex('pk_kestrel0123456789abcdef'), new Date().toISOString()).run();
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_matrix', arguments: { tender_id: 'tnd_sample_teagasc_p4941' } } }, 'pk_kestrel0123456789abcdef');
    const j = (await res.json()) as { result: { structuredContent: { shown: number } } };
    expect(j.result.structuredContent.shown).toBe(0); // Harbour's requirements are invisible to Kestrel
  });
});
