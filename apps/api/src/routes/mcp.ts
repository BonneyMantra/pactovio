import { Hono } from 'hono';
import { z } from 'zod';
import { agentTools, getTool, invokeTool, toolJsonSchema } from '@pactovio/agent';
import { HttpError, type PendingAction } from '@pactovio/contracts';
import { hubJson } from '../do/client';
import { clipJson } from '../do/summarize';
import { apiKeyAuth } from '../lib/auth';
import type { AppEnv } from '../lib/types';

/** MCP over streamable HTTP (JSON responses only, stateless). Exposes the same `agentTools` as the chat, behind an API key. */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const INSTRUCTIONS = 'Pactovio pre-sales tools: read tenders, requirement matrices and verdicts, search and draft. Tools that change state or reach outside (start a run, draft or approve answers, create a design request or quote, connector actions) do not execute: they return status "pending_confirmation" with an action_id and a person confirms it in the Pactovio chat or Slack. Never claim a pending action happened.';

const Rpc = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).nullish(), method: z.string().min(1), params: z.unknown().optional() });
type Id = string | number | null;
const ok = (id: Id, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });
const err = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.post('/mcp', async (c) => {
  let auth;
  try {
    auth = await apiKeyAuth(c);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 401;
    return c.json({ error: e instanceof Error ? e.message : 'Unauthorized', code: 'unauthorized' }, status, { 'www-authenticate': 'Bearer realm="pactovio"' });
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err(null, -32700, 'Parse error'), 400); }

  const handle = async (raw: unknown) => {
    const parsed = Rpc.safeParse(raw);
    if (!parsed.success) return err(null, -32600, 'Invalid Request');
    const { id, method, params } = parsed.data;
    if (id === undefined || id === null) return null; // notification: no response
    try {
      switch (method) {
        case 'initialize': {
          const asked = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
          const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked ?? '') ? asked : SUPPORTED_PROTOCOLS[0];
          return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pactovio', title: 'Pactovio', version: '0.1.0' }, instructions: INSTRUCTIONS });
        }
        case 'ping': return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: agentTools.map((t) => ({
            name: t.name, title: t.name.replace(/_/g, ' '), description: t.description, inputSchema: toolJsonSchema(t),
            annotations: { readOnlyHint: !t.mutating && !t.needsConfirmation, destructiveHint: false, openWorldHint: !!t.mutating },
          })) });
        case 'tools/call': {
          const p = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
          if (!p.success) return err(id, -32602, 'Invalid params: expected { name, arguments }');
          if (!getTool(p.data.name)) return err(id, -32602, `Unknown tool: ${p.data.name}`);
          return ok(id, await callTool(c.env, auth.workspaceId, p.data.name, p.data.arguments ?? {}));
        }
        default: return err(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      console.error('mcp error', e instanceof Error ? e.name : 'unknown');
      return err(id, -32603, 'Internal error');
    }
  };

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter((r) => r !== null);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const res = await handle(body);
  return res === null ? c.body(null, 202) : c.json(res);
});

async function callTool(env: AppEnv['Bindings'], workspaceId: string, name: string, args: Record<string, unknown>) {
  const text = (v: unknown) => JSON.stringify(v);
  const o = await invokeTool(env, { workspaceId, sessionId: null, source: 'mcp' }, name, args);
  if (o.status === 'ok') {
    const result = clipJson(o.result, 12_000);
    return { content: [{ type: 'text', text: text(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result }, isError: false };
  }
  if (o.status === 'error') return { content: [{ type: 'text', text: text({ error: o.error, code: o.code }) }], isError: true };
  const action = await hubJson<PendingAction>(env, { workspaceId, sessionId: null }, '/pending', { body: { tool: o.tool, input: o.input, title: o.title, detail: o.detail, summary: o.summary } });
  const out = { status: 'pending_confirmation', action_id: action.id, title: o.title, detail: o.detail, note: 'Not executed. A person must confirm it in the Pactovio chat or Slack.' };
  return { content: [{ type: 'text', text: text(out) }], structuredContent: out, isError: false };
}

mcpRoutes.get('/mcp', (c) => c.json({ error: 'This MCP server answers POST JSON-RPC only', code: 'method_not_allowed' }, 405, { allow: 'POST' }));
mcpRoutes.delete('/mcp', (c) => c.body(null, 405, { allow: 'POST' }));
