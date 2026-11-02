import { getTool, invokeTool as invoke, type AgentToolCtx, type ToolOutcome } from '@pactovio/agent';
import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { requirePackAccess, requireTender } from './tenders';

/** Guard the shared agent library at the API/DO boundary, including confirmation-card descriptions. */
export async function invokeTool(env: Env, ctx: AgentToolCtx, name: string, raw: unknown): Promise<ToolOutcome> {
  const tool = getTool(name);
  const parsed = tool?.input.safeParse(raw);
  if (!parsed?.success) return invoke(env, ctx, name, raw);
  const input = parsed.data as Record<string, unknown>;
  try {
    if (typeof input.tender_id === 'string') {
      await requireTender(env.DB, input.tender_id, ctx.workspaceId);
      if (['get_tender', 'start_pack_run', 'draft_answer', 'draft_answers', 'fill_form'].includes(name)) await requirePackAccess(env.DB, input.tender_id, ctx.workspaceId);
    }
    for (const [key, table] of [['answer_id', 'answers'], ['design_request_id', 'design_requests'], ['quote_id', 'quotes']] as const) {
      if (typeof input[key] === 'string' && !await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND workspace_id = ?`).bind(input[key], ctx.workspaceId).first()) {
        throw new HttpError(404, 'Item not found', 'not_found');
      }
    }
    if (name === 'buyer_intel') {
      const key = input.buyer_key ?? (typeof input.tender_id === 'string' ? (await requireTender(env.DB, input.tender_id, ctx.workspaceId)).buyer_key : '');
      const owned = await env.DB.prepare(`SELECT t.id FROM tenders t JOIN tender_matches m ON m.tender_id = t.id WHERE m.workspace_id = ? AND t.buyer_key = ?
        UNION SELECT t.id FROM tenders t JOIN intakes i ON i.tender_id = t.id WHERE i.workspace_id = ? AND t.buyer_key = ? LIMIT 1`)
        .bind(ctx.workspaceId, key ?? '', ctx.workspaceId, key ?? '').first();
      if (!owned) throw new HttpError(404, 'Buyer not found', 'not_found');
    }
    return invoke(env, ctx, name, raw);
  } catch (e) {
    if (e instanceof HttpError) return { status: 'error', error: e.message, code: e.code ?? 'error' };
    throw e;
  }
}
