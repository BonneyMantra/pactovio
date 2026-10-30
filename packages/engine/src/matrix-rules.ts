import type { ReqKind, ReqStatus } from '@pactovio/contracts';
import type { Coverage } from './schemas';
import type { GateResult } from './gates';

/** Cosine thresholds for Qwen3-Embedding-8B (1024 dims); calibrated on the Teagasc run, change with evidence. */
export const SIM = { strong: 0.5, weak: 0.32, floor: 0.2 } as const;

export interface RankedEvidence { evidenceId: string; score: number; validTo: string | null }
export interface Judgement { coverage: Coverage; evidence_ids: string[]; note: string }
export interface Resolved { status: ReqStatus; evidence_ids: string[]; note: string }

/**
 * Explicit status rules, applied after the model has judged coverage. The model never sets a status directly:
 * - info rows need no evidence (MET);
 * - the model saying "covers" is not trusted when retrieval similarity is weak (PARTIAL);
 * - "contradicts" is the only route to GAP; "none" means the library cannot answer (NEEDS_EVIDENCE);
 * - evidence that expires before the tender deadline downgrades MET to PARTIAL.
 */
export function resolveStatus(kind: ReqKind, ranked: RankedEvidence[], j: Judgement | null, deadline: Date | null): Resolved {
  if (kind === 'info') return { status: 'MET', evidence_ids: [], note: 'Informational, no response evidence needed.' };
  const best = ranked[0]?.score ?? 0;
  if (!j || best < SIM.floor) return { status: 'NEEDS_EVIDENCE', evidence_ids: [], note: 'Nothing in the evidence library speaks to this requirement.' };
  const picked = j.evidence_ids.filter((id) => ranked.some((r) => r.evidenceId === id));
  const ids = picked.length ? picked : ranked.slice(0, 2).map((r) => r.evidenceId);
  switch (j.coverage) {
    case 'contradicts': return { status: 'GAP', evidence_ids: ids, note: j.note };
    case 'none': return { status: 'NEEDS_EVIDENCE', evidence_ids: [], note: j.note || 'No matching evidence in the library.' };
    case 'partial': return { status: 'PARTIAL', evidence_ids: ids, note: j.note };
    case 'covers': {
      if (best < SIM.weak) return { status: 'PARTIAL', evidence_ids: ids, note: `${j.note} (retrieval match is weak, check the source)` };
      const expired = ids.map((id) => ranked.find((r) => r.evidenceId === id)).find((r) => r?.validTo && deadline && new Date(`${r.validTo}T23:59:59Z`) < deadline);
      if (expired) return { status: 'PARTIAL', evidence_ids: ids, note: `${j.note} Evidence expires ${expired.validTo}, before the tender deadline.` };
      return { status: 'MET', evidence_ids: ids, note: j.note };
    }
  }
}

/** Requirement rows that mirror a gate take their status from the code check, never from retrieval. */
export function statusFromGate(g: GateResult): Resolved {
  if (g.status === 'pass') return { status: 'MET', evidence_ids: [], note: g.detail };
  if (g.status === 'fail') return { status: 'GAP', evidence_ids: [], note: g.detail };
  return { status: 'NEEDS_EVIDENCE', evidence_ids: [], note: g.detail };
}

const CREDIT: Record<ReqStatus, number> = { MET: 1, PARTIAL: 0.5, NEEDS_EVIDENCE: 0.35, GAP: 0 };

export interface ScoredReq { kind: ReqKind; weight: number | null; status: ReqStatus }

/** Weighted coverage 0-100. Weight = award weight when scored, otherwise 1 (mandatory) or 0.25 (info). */
export function coverageScore(reqs: ScoredReq[]): number {
  let num = 0, den = 0;
  for (const r of reqs) {
    const w = r.weight ?? (r.kind === 'mandatory' ? 1 : r.kind === 'scored' ? 0.75 : 0.25);
    num += w * CREDIT[r.status];
    den += w;
  }
  return den ? Math.round((num / den) * 100) : 0;
}

export type DecisionT = 'BID' | 'NO_BID' | 'CONDITIONAL';

/**
 * Bid decision by rule: a failed hard gate or very weak coverage is NO_BID; open gaps, unverifiable gates
 * or middling coverage are CONDITIONAL; otherwise BID.
 */
export function decide(gates: GateResult[], reqs: ScoredReq[]): { decision: DecisionT; score: number } {
  const score = coverageScore(reqs);
  const mandatoryGaps = reqs.filter((r) => r.kind === 'mandatory' && r.status === 'GAP').length;
  if (gates.some((g) => g.status === 'fail')) return { decision: 'NO_BID', score: Math.min(score, 34) };
  if (score < 35 || mandatoryGaps >= 3) return { decision: 'NO_BID', score };
  if (mandatoryGaps > 0 || gates.some((g) => g.status === 'unknown') || score < 65) return { decision: 'CONDITIONAL', score };
  return { decision: 'BID', score };
}
