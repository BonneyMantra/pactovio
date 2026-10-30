import { z } from 'zod';
import { newId } from '@pactovio/contracts';
import { draftAnswers, startPackRun } from '@pactovio/engine';
import { createQuote, matchDesignRequest } from '@pactovio/quote';
import { runAction } from '@pactovio/connectors';
import { clip, formatMoney } from '../format';
import { defineTool, type AgentTool } from '../types';
import { exec, one, requireTender, rows, ToolError } from './db';

const tenderId = z.string().min(3).describe('Tender id, e.g. tnd_sample_teagasc_p4941');

async function tenderTitle(env: Parameters<AgentTool['run']>[0], id: string): Promise<string> {
  return (await one<{ title: string }>(env, 'SELECT title FROM tenders WHERE id = ?', id))?.title ?? id;
}

export const startPackRunTool = defineTool({
  name: 'start_pack_run',
  description: 'Use when the user asks to start, read, analyse or run a tender pack. Starts a pack run on a tender: Pactovio reads the whole document pack, extracts requirements, checks them against the evidence library and produces the matrix and per-lot verdicts. Spends model credits, so the user must confirm.',
  input: z.object({ tender_id: tenderId, replay: z.boolean().default(false).describe('true plays the labelled showcase replay instead of a fresh run') }),
  mutating: true,
  async describe(env, _c, i) {
    return { title: i.replay ? 'Replay the showcase run?' : 'Read the pack?', detail: `${await tenderTitle(env, i.tender_id)}. ${i.replay ? 'Plays a recorded run, labelled replay.' : 'A fresh run reads every document and uses one of your session\'s fresh runs.'}` };
  },
  async run(env, ctx, i) {
    await requireTender(env, i.tender_id);
    const runId = await startPackRun(env, { workspaceId: ctx.workspaceId, tenderId: i.tender_id, sessionId: ctx.sessionId ?? undefined, replay: i.replay });
    return { run_id: runId, tender_id: i.tender_id, replay: i.replay };
  },
});

export const draftAnswersTool = defineTool({
  name: 'draft_answers',
  description: 'Draft answers to the tender\'s questions from the evidence library; every claim is checked against evidence and unsupported ones are flagged. Without `questions` it redrafts the answers already listed for the tender.',
  input: z.object({
    tender_id: tenderId, lot: z.string().optional(),
    questions: z.array(z.object({ ref: z.string(), question: z.string().max(2000), word_limit: z.number().int().positive().optional() })).max(10).optional(),
  }),
  mutating: true,
  async describe(env, _c, i) {
    return { title: 'Draft answers?', detail: `${await tenderTitle(env, i.tender_id)}${i.lot ? `, lot ${i.lot}` : ''}. Drafts stay unapproved until you approve each one.` };
  },
  async run(env, ctx, i) {
    await requireTender(env, i.tender_id);
    let questions = (i.questions ?? []).map((q) => ({ ref: q.ref, question: q.question, wordLimit: q.word_limit }));
    if (!questions.length) {
      const existing = await rows<{ question_ref: string; question: string; word_limit: number | null; lot: string | null }>(
        env, 'SELECT question_ref, question, word_limit, lot FROM answers WHERE workspace_id = ? AND tender_id = ? ORDER BY question_ref', ctx.workspaceId, i.tender_id);
      questions = existing.filter((a) => !i.lot || a.lot === i.lot).map((a) => ({ ref: a.question_ref, question: a.question, wordLimit: a.word_limit ?? undefined }));
    }
    if (!questions.length) throw new ToolError('No questions known for this tender; pass `questions`.', 'validation');
    const out = await draftAnswers(env, { workspaceId: ctx.workspaceId, tenderId: i.tender_id, lot: i.lot, questions });
    return { drafted: out.length, answers: out.map((a) => ({ answer_id: a.id, ref: a.question_ref, status: a.status, unsupported_claims: a.claims.filter((c) => !c.supported).length })) };
  },
});

export const approveAnswerTool = defineTool({
  name: 'approve_answer',
  description: 'Approve a drafted answer so it can go into the filled form. Approval is a human decision: this always asks the user first.',
  input: z.object({ answer_id: z.string().min(3) }),
  mutating: true,
  async describe(env, ctx, i) {
    const a = await one<{ question_ref: string; draft: string; claims: { supported: boolean }[]; tender_id: string }>(env, 'SELECT question_ref, draft, claims_json, tender_id FROM answers WHERE id = ? AND workspace_id = ?', i.answer_id, ctx.workspaceId);
    if (!a) return { title: 'Approve answer?', detail: i.answer_id };
    const flagged = a.claims?.filter((c) => !c.supported).length ?? 0;
    return { title: `Approve answer ${a.question_ref}?`, detail: `${await tenderTitle(env, a.tender_id)}. "${clip(a.draft, 140)}"${flagged ? ` Warning: ${flagged} claim${flagged === 1 ? '' : 's'} not backed by evidence.` : ' All claims are backed by evidence.'}` };
  },
  async run(env, ctx, i) {
    const a = await one<{ id: string; status: string; question_ref: string }>(env, 'SELECT id, status, question_ref FROM answers WHERE id = ? AND workspace_id = ?', i.answer_id, ctx.workspaceId);
    if (!a) throw new ToolError(`No answer ${i.answer_id} in this workspace`, 'not_found');
    const at = new Date().toISOString();
    await exec(env, "UPDATE answers SET status = 'approved', approved_at = COALESCE(approved_at, ?) WHERE id = ? AND workspace_id = ?", at, a.id, ctx.workspaceId);
    return { answer_id: a.id, question_ref: a.question_ref, status: 'approved', approved_at: at };
  },
});

export const createDesignRequestTool = defineTool({
  name: 'create_design_request_from_text',
  description: 'Create a design request (a customer asking for a product to a spec) from pasted text, in the inbox. Follow with match_design_request to match the spec to the product catalogue.',
  input: z.object({ customer: z.string().min(2).max(120), subject: z.string().min(3).max(200), spec_text: z.string().min(10).max(12_000) }),
  mutating: true,
  async describe(_e, _c, i) {
    return { title: 'Create design request?', detail: `${i.customer}: ${i.subject}. Adds it to your inbox.` };
  },
  async run(env, ctx, i) {
    const intakeId = newId('intake');
    const dsgId = newId('designRequest');
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO intakes (id, workspace_id, door, source, title, sender, received_at, status, design_request_id) VALUES (?, ?, 'design', ?, ?, ?, ?, 'new', ?)")
        .bind(intakeId, ctx.workspaceId, ctx.source === 'mcp' ? 'mcp' : 'chat', i.subject, i.customer, at, dsgId),
      env.DB.prepare("INSERT INTO design_requests (id, workspace_id, intake_id, customer, subject, spec_text, status) VALUES (?, ?, ?, ?, ?, ?, 'new')")
        .bind(dsgId, ctx.workspaceId, intakeId, i.customer, i.subject, i.spec_text),
    ]);
    return { design_request_id: dsgId, intake_id: intakeId, status: 'new' };
  },
});

export const matchDesignRequestTool = defineTool({
  name: 'match_design_request',
  description: 'Extract the requirements from a design request and match them against the product catalogue (gaps and partial matches are listed).',
  input: z.object({ design_request_id: z.string().min(3) }),
  mutating: true,
  async describe(env, ctx, i) {
    const d = await one<{ customer: string; subject: string }>(env, 'SELECT customer, subject FROM design_requests WHERE id = ? AND workspace_id = ?', i.design_request_id, ctx.workspaceId);
    return { title: 'Start spec match?', detail: d ? `${d.customer}: ${d.subject}. Reads the spec and matches it against your catalogue.` : i.design_request_id };
  },
  async run(env, ctx, i) {
    const d = await one<{ id: string }>(env, 'SELECT id FROM design_requests WHERE id = ? AND workspace_id = ?', i.design_request_id, ctx.workspaceId);
    if (!d) throw new ToolError(`No design request ${i.design_request_id} in this workspace`, 'not_found');
    const r = await matchDesignRequest(env, d.id);
    return { design_request_id: r.id, status: r.status, requirements: r.requirements.length, matches: r.matches };
  },
});

export const createQuoteTool = defineTool({
  name: 'create_quote',
  description: 'Create a priced quote for a design request or tender from the matched products. Pricing is computed in code, never by the model. Needs user confirmation.',
  input: z.object({ design_request_id: z.string().optional(), tender_id: z.string().optional(), product_ids: z.array(z.string()).optional(), qty: z.number().int().min(1).max(100_000).optional() }),
  mutating: true,
  async describe(env, ctx, i) {
    const d = i.design_request_id ? await one<{ customer: string; subject: string }>(env, 'SELECT customer, subject FROM design_requests WHERE id = ? AND workspace_id = ?', i.design_request_id, ctx.workspaceId) : null;
    return { title: 'Create a quote?', detail: `${d ? `${d.customer}: ${d.subject}` : i.tender_id ? await tenderTitle(env, i.tender_id) : 'New quote'}${i.qty ? `, quantity ${i.qty}` : ''}. Prices come from your catalogue and price rules.` };
  },
  async run(env, ctx, i) {
    if (!i.design_request_id && !i.tender_id) throw new ToolError('Give design_request_id or tender_id', 'validation');
    const q = await createQuote(env, { workspaceId: ctx.workspaceId, designRequestId: i.design_request_id, tenderId: i.tender_id, productIds: i.product_ids, qty: i.qty });
    return { quote_id: q.id, status: q.status, currency: q.currency, total: formatMoney(q.total_minor, q.currency), total_minor: q.total_minor, lines: q.lines.length, valid_until: q.valid_until };
  },
});

export const runConnectorActionTool = defineTool({
  name: 'run_connector_action',
  description: 'Run an action on a connected third-party tool, for example slack post_message, googlecalendar create_event, hubspot create_deal. Reaches outside Pactovio, so the user must confirm.',
  input: z.object({ provider: z.string().min(2).max(40), action: z.string().min(2).max(60), input: z.record(z.string(), z.unknown()).default({}) }),
  mutating: true,
  async describe(_e, _c, i) {
    return { title: `Run ${i.provider} ${i.action}?`, detail: clip(JSON.stringify(i.input), 220) };
  },
  async run(env, ctx, i) {
    const c = await one<{ status: string }>(env, 'SELECT status FROM connectors WHERE workspace_id = ? AND provider = ?', ctx.workspaceId, i.provider);
    if (c?.status !== 'connected') throw new ToolError(`${i.provider} is not connected for this workspace`, 'not_connected');
    const out = await runAction(env, ctx.workspaceId, i.provider, i.action, i.input);
    return { ok: out.ok, provider: i.provider, action: i.action, output: out.output };
  },
});

