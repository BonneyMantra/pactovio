import { fromRow, HttpError, newId, type Answer, type CompanyProfile, type Evidence } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { chat, type StepLogger } from '@pactovio/models';
import { claimCheckSync, NEEDS_EVIDENCE_TAG, splitSentences, strikeUnsupported } from './claims';
import { SIM } from './matrix-rules';
import { ensureEmbeddings, ensureProfileEvidence, loadChunks, rankQueries, type ChunkRef } from './retrieve';
import { nowIso, wordCount, mapLimit } from './util';

export interface Question { ref: string; question: string; wordLimit?: number }

/** Cut to `limit` words on a sentence boundary; the model is asked for the limit, code guarantees it. */
export function enforceWordLimit(text: string, limit: number | null | undefined): string {
  if (!limit || wordCount(text) <= limit) return text;
  const out: string[] = [];
  let n = 0;
  for (const s of splitSentences(text)) {
    const w = wordCount(s);
    if (n + w > limit) break;
    out.push(s);
    n += w;
  }
  return out.length ? out.join(' ') : text.split(/\s+/).slice(0, limit).join(' ');
}

const SYSTEM = (company: string) => `You write tender response answers for ${company}.
Hard rules:
1. Use ONLY facts stated in the EVIDENCE block.
2. Never invent or round numbers, dates, certifications, client names, service levels or headcounts. Copy them exactly as written in the evidence.
3. If the evidence does not cover part of the question, leave that part out. Never fill a gap with a promise.
4. Write in the first person plural ("we"), plain professional prose in short paragraphs. No headings, no bullet points, no markdown.
5. Answer the question directly in the first sentence.`;

interface DraftIn {
  workspaceId: string; tenderId: string; lot: string | null; q: Question;
  ranked: { chunk: ChunkRef; score: number }[];
  evidence: Evidence[]; company: string; buyer: string; runId?: string;
  onStep?: StepLogger; fetch?: typeof fetch;
}

async function draftOne(env: Env, d: DraftIn): Promise<Answer> {
  const useful = d.ranked.filter((r) => r.score >= SIM.floor);
  const ids = [...new Set(useful.map((r) => r.chunk.evidenceId))];
  const ev = d.evidence.filter((e) => ids.includes(e.id));
  let draft: string;
  if (!ev.length) {
    draft = `${NEEDS_EVIDENCE_TAG}: nothing in the evidence library answers "${d.q.question.slice(0, 80)}"]`;
  } else {
    const limit = d.q.wordLimit ?? 250;
    const user = `BUYER: ${d.buyer}\nQUESTION (${d.q.ref}): ${d.q.question}\nWORD LIMIT: ${limit}\n\nEVIDENCE:\n${useful.map((r) => `[${r.chunk.evidenceId}] ${r.chunk.title}: ${r.chunk.text}`).join('\n')}`;
    const res = await chat({
      env, role: 'fast', purpose: `Draft answer ${d.q.ref}${d.lot ? ` (Lot ${d.lot})` : ''}`, maxTokens: Math.min(2500, limit * 3 + 200), temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM(d.company) }, { role: 'user', content: user }], onStep: d.onStep, fetch: d.fetch,
    });
    draft = enforceWordLimit(res.text.replace(/\*\*|^#+\s*/gm, '').trim(), d.q.wordLimit);
  }
  const claims = claimCheckSync(draft, ev, { allow: [d.company, d.buyer] });
  const struck = strikeUnsupported(draft, claims);
  const id = newId('answer');
  await env.DB.prepare(`DELETE FROM answers WHERE workspace_id = ? AND tender_id = ? AND question_ref = ? AND COALESCE(lot, '') = ? AND status = 'draft'`).bind(d.workspaceId, d.tenderId, d.q.ref, d.lot ?? '').run();
  await env.DB.prepare('INSERT INTO answers (id, workspace_id, tender_id, lot, question_ref, question, word_limit, draft, claims_json, status, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
    .bind(id, d.workspaceId, d.tenderId, d.lot, d.q.ref, d.q.question, d.q.wordLimit ?? null, struck, JSON.stringify(claims), 'draft').run();
  await env.DB.prepare("INSERT INTO audits (id, workspace_id, subject_type, subject_id, job_id, status, result_json, created_at, completed_at) VALUES (?, ?, 'answer', ?, NULL, 'queued', NULL, ?, NULL)")
    .bind(newId('audit'), d.workspaceId, id, nowIso()).run();
  await emit(env, d.workspaceId, 'answer.drafted', { tender_id: d.tenderId, lot: d.lot, question_ref: d.q.ref, answer_id: id, unsupported_claims: claims.filter((c) => !c.supported).length, run_id: d.runId ?? null });
  const row = await env.DB.prepare('SELECT * FROM answers WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return fromRow<Answer>(row!);
}

/**
 * Draft answers (fast model, thinking off) only from retrieved evidence, in the buyer's word limit.
 * Every sentence is claim-checked in code; unsupported claims are struck and flagged NEEDS_EVIDENCE.
 * One `audits` row (queued) per draft feeds the NeMo Guardrails job.
 */
export async function draftAnswersImpl(
  env: Env,
  input: { workspaceId: string; tenderId: string; lot?: string; questions: Question[] },
  o: { runId?: string; onStep?: StepLogger; fetch?: typeof fetch } = {},
): Promise<Answer[]> {
  const ws = await env.DB.prepare('SELECT name, profile_json FROM workspaces WHERE id = ?').bind(input.workspaceId).first<{ name: string; profile_json: string }>();
  if (!ws) throw new HttpError(404, 'Workspace not found', 'not_found');
  const profile = JSON.parse(ws.profile_json) as CompanyProfile;
  const t = await env.DB.prepare('SELECT buyer FROM tenders WHERE id = ?').bind(input.tenderId).first<{ buyer: string }>();
  if (!t) throw new HttpError(404, 'Tender not found', 'not_found');
  await ensureProfileEvidence(env, input.workspaceId, profile);
  await ensureEmbeddings(env, input.workspaceId, o);
  const chunks = await loadChunks(env, input.workspaceId);
  const evidence = (await env.DB.prepare('SELECT * FROM evidence WHERE workspace_id = ?').bind(input.workspaceId).all<Record<string, unknown>>()).results.map((r) => fromRow<Evidence>(r));
  const ranked = await rankQueries(input.questions.map((q) => q.question), chunks, { env, purpose: `Embed ${input.questions.length} question(s) and retrieve evidence`, topK: 5, onStep: o.onStep, fetch: o.fetch });
  const out = await mapLimit(input.questions, 4, (q, i) =>
    draftOne(env, { workspaceId: input.workspaceId, tenderId: input.tenderId, lot: input.lot ?? null, q, ranked: ranked[i] ?? [], evidence, company: profile.legal_name, buyer: t.buyer, runId: o.runId, onStep: o.onStep, fetch: o.fetch }));
  return out;
}
