import { newId, type CompanyProfile, type Evidence, type ReqKind, type ReqStatus } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { chatJSON, type StepLogger } from '@pactovio/models';
import { docIdFor } from './extract';
import type { GateResult } from './gates';
import { resolveStatus, statusFromGate, type Judgement } from './matrix-rules';
import { rankQueries, type ChunkRef, type Ranked } from './retrieve';
import { ExtractedReq, JudgeBatch, type GateSpec } from './schemas';
import { mapLimit } from './util';

type DocRef = { docId: string; filename: string };

/** Replace the requirement rows of (workspace, tender) with this run's extraction. Gate rows carry code-evaluated status. */
export async function persistRequirements(
  env: Env,
  o: { workspaceId: string; tenderId: string; docs: DocRef[]; lots: Record<string, ExtractedReq[]>; gates: { spec: GateSpec; result: GateResult }[] },
): Promise<number> {
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM requirements WHERE workspace_id = ? AND tender_id = ?').bind(o.workspaceId, o.tenderId),
    // clean slate for the drafts of the previous run and the seeded sample drafts; approved answers are kept
    db.prepare("DELETE FROM answers WHERE workspace_id = ? AND tender_id = ? AND (status = 'draft' OR id LIKE 'ans_sample%')").bind(o.workspaceId, o.tenderId),
  ];
  const ins = db.prepare('INSERT INTO requirements (id, workspace_id, tender_id, lot, ref, text, kind, weight, doc_id, page, status, evidence_ids_json, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const g of o.gates) {
    const s = statusFromGate(g.result);
    stmts.push(ins.bind(newId('requirement'), o.workspaceId, o.tenderId, g.spec.lot, g.spec.ref, g.spec.text, 'mandatory', null, docIdFor(o.docs, g.spec.doc), g.spec.page, s.status, '[]', s.note));
  }
  let n = o.gates.length;
  for (const [lot, reqs] of Object.entries(o.lots)) {
    for (const r of reqs) {
      stmts.push(ins.bind(newId('requirement'), o.workspaceId, o.tenderId, lot, r.ref, r.text, r.kind, r.weight, docIdFor(o.docs, r.doc), r.page, 'NEEDS_EVIDENCE', '[]', r.note));
      n++;
    }
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  return n;
}

const JUDGE_SYSTEM = `You judge whether a supplier's evidence satisfies tender requirements.
For each numbered requirement and its candidate evidence give coverage:
- covers: the evidence directly satisfies every element of the requirement;
- partial: it satisfies part of it, or satisfies it only with a caveat;
- contradicts: the evidence shows the supplier does NOT or cannot meet it (for example a lower service level than required);
- none: the evidence is unrelated or silent. Requirements that ask the supplier to describe an approach or to confirm a future commitment are "none" unless the evidence already states it.
List the evidence ids you relied on. note: one plain sentence citing facts from the evidence. Compare numbers only as printed; do no arithmetic. Output JSON only.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

export async function judgeBatch(
  env: Env,
  batch: { idx: number; text: string; ranked: Ranked[] }[],
  o: { onStep?: StepLogger; fetch?: typeof fetch; purpose: string },
): Promise<Map<number, Judgement>> {
  const body = batch.map((b) => `[${b.idx}] REQUIREMENT: ${clip(b.text, 700)}\nEVIDENCE:\n${b.ranked.map((r) => `- (${r.chunk.evidenceId}) ${r.chunk.title}: ${clip(r.chunk.text, 500)}`).join('\n') || '- (none retrieved)'}`).join('\n\n');
  const { data } = await chatJSON(JudgeBatch, {
    env, role: 'fast', purpose: o.purpose, schemaName: 'judgements', maxTokens: 3000, onStep: o.onStep, fetch: o.fetch,
    messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: body }],
  });
  return new Map(data.judgements.map((j) => [j.idx, { coverage: j.coverage, evidence_ids: j.evidence_ids, note: j.note }]));
}

export interface MatchOutcome { counts: Record<ReqStatus, number>; judged: number }

/** Rank evidence per requirement (cosine in code), let the fast model judge coverage, then apply the explicit status rules. */
export async function matchEvidence(
  env: Env,
  o: { workspaceId: string; tenderId: string; chunks: ChunkRef[]; deadline: Date | null; gateKeys: Set<string>; profile: CompanyProfile; gateResults: GateResult[]; onStep?: StepLogger; fetch?: typeof fetch },
): Promise<MatchOutcome> {
  const rows = (await env.DB.prepare('SELECT id, lot, ref, text, kind FROM requirements WHERE workspace_id = ? AND tender_id = ?').bind(o.workspaceId, o.tenderId).all<{ id: string; lot: string | null; ref: string; text: string; kind: ReqKind }>()).results;
  const work = rows.filter((r) => r.kind !== 'info' && !o.gateKeys.has(`${r.lot ?? ''}|${r.ref}`));
  const ranked = await rankQueries(work.map((r) => r.text.slice(0, 800)), o.chunks, { env, purpose: `Embed ${work.length} requirements and rank evidence by cosine`, topK: 4, onStep: o.onStep, fetch: o.fetch });
  const batches: { idx: number; text: string; ranked: Ranked[] }[][] = [];
  work.forEach((r, i) => {
    const b = batches[Math.floor(i / 8)] ?? (batches[Math.floor(i / 8)] = []);
    b.push({ idx: i, text: r.text, ranked: ranked[i]!.slice(0, 3) });
  });
  const judged = new Map<number, Judgement>();
  await mapLimit(batches, 6, async (b, n) => {
    try {
      for (const [k, v] of await judgeBatch(env, b, { onStep: o.onStep, fetch: o.fetch, purpose: `Judge evidence coverage (batch ${n + 1} of ${batches.length})` })) judged.set(k, v);
    } catch (e) {
      console.error('engine: judge batch failed', e instanceof Error ? e.message : e);
    }
  });
  const counts: Record<ReqStatus, number> = { MET: 0, PARTIAL: 0, GAP: 0, NEEDS_EVIDENCE: 0 };
  const stmts: D1PreparedStatement[] = [];
  const upd = env.DB.prepare('UPDATE requirements SET status = ?, evidence_ids_json = ?, note = ? WHERE id = ?');
  work.forEach((r, i) => {
    const res = resolveStatus(r.kind, ranked[i]!.map((x) => ({ evidenceId: x.chunk.evidenceId, score: x.score, validTo: x.chunk.validTo })), judged.get(i) ?? null, o.deadline);
    counts[res.status]++;
    stmts.push(upd.bind(res.status, JSON.stringify(res.evidence_ids), res.note.slice(0, 600), r.id));
  });
  for (const r of rows.filter((x) => x.kind === 'info')) {
    counts.MET++;
    stmts.push(upd.bind('MET', '[]', 'Informational, no response evidence needed.', r.id));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return { counts, judged: judged.size };
}

export type { Evidence };
