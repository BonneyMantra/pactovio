import { newId, type ReqStatus } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import { chatJSON, type StepLogger } from '@pactovio/models';
import { SYSTEM } from './extract';
import type { GateResult } from './gates';
import { decide, type DecisionT } from './matrix-rules';
import { VerdictReasons } from './schemas';

interface Row { ref: string; text: string; kind: 'mandatory' | 'scored' | 'info'; weight: number | null; status: ReqStatus; doc_id: string | null; page: number | null; note: string | null }

export interface LotVerdict { lot: string; decision: DecisionT; score: number; reasons: string[] }

/** Gates and the decision are computed in code; the reasoning model only explains them, citing documents and pages. */
export async function writeVerdict(
  env: Env,
  o: { workspaceId: string; tenderId: string; runId: string; lot: string; gates: GateResult[]; pack: string; docNames: Record<string, string>; onStep?: StepLogger; fetch?: typeof fetch },
): Promise<LotVerdict> {
  const rows = (await env.DB.prepare('SELECT ref, text, kind, weight, status, doc_id, page, note FROM requirements WHERE workspace_id = ? AND tender_id = ? AND (lot = ? OR lot IS NULL) ORDER BY ref')
    .bind(o.workspaceId, o.tenderId, o.lot).all<Row>()).results;
  const { decision, score } = decide(o.gates, rows);
  const counts = (s: ReqStatus) => rows.filter((r) => r.status === s).length;
  const where = (r: Row) => `${r.doc_id ? (o.docNames[r.doc_id] ?? r.doc_id) : 'pack'}${r.page ? ` p.${r.page}` : ''}`;
  const open = rows.filter((r) => r.status !== 'MET').sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.kind === 'mandatory' ? -1 : 1)).slice(0, 14);
  const task = `Write the bid / no-bid reasoning for LOT ${o.lot}.
The decision was computed by fixed rules and must not be changed: ${decision} (coverage score ${score}/100).
Gate checks (computed in code from the company profile):
${o.gates.map((g) => `- ${g.name}: ${g.status.toUpperCase()}, ${g.detail}`).join('\n')}
Requirement matrix: ${counts('MET')} met, ${counts('PARTIAL')} partial, ${counts('GAP')} gaps, ${counts('NEEDS_EVIDENCE')} need evidence, of ${rows.length}.
Open items:
${open.map((r) => `- ${r.ref} [${r.kind}${r.weight ? `, ${r.weight}%` : ''}, ${r.status}] ${r.text.slice(0, 200)} (${where(r)}) ${r.note ? `Note: ${r.note.slice(0, 160)}` : ''}`).join('\n')}
Give 3 to 5 reasons a bid manager can act on. Each reason is one or two sentences, names the requirement ref and cites document and page when it concerns a requirement, and states what to do. Use only the figures above.`;
  const { data } = await chatJSON(VerdictReasons, {
    env, role: 'reason', purpose: `Verdict reasoning: Lot ${o.lot} (${decision})`, schemaName: 'verdict_reasons', maxTokens: 6000, timeoutMs: 600_000, onStep: o.onStep, fetch: o.fetch,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${o.pack}\n\nTASK\n${task}` }],
  });
  await env.DB.prepare('DELETE FROM verdicts WHERE workspace_id = ? AND tender_id = ? AND lot = ?').bind(o.workspaceId, o.tenderId, o.lot).run();
  await env.DB.prepare('INSERT INTO verdicts (id, workspace_id, tender_id, lot, decision, score, gates_json, reasons_json, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('verdict'), o.workspaceId, o.tenderId, o.lot, decision, score, JSON.stringify(o.gates.map((g) => ({ name: g.name, passed: g.status === 'pass', detail: g.detail }))), JSON.stringify(data.reasons), o.runId).run();
  await emit(env, o.workspaceId, 'verdict.ready', { tender_id: o.tenderId, lot: o.lot, decision, score, run_id: o.runId });
  return { lot: o.lot, decision, score, reasons: data.reasons };
}
