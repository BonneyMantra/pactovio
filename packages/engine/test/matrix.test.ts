import { describe, expect, it } from 'vitest';
import { resolveStatus, SIM, statusFromGate, type Judgement, type RankedEvidence } from '../src/matrix-rules';

const rk = (score: number, validTo: string | null = null, id = 'evd_a'): RankedEvidence[] => [{ evidenceId: id, score, validTo }];
const j = (coverage: Judgement['coverage'], ids = ['evd_a'], note = 'n'): Judgement => ({ coverage, evidence_ids: ids, note });
const deadline = new Date('2026-11-19T14:00:00Z');

describe('matrix status rules', () => {
  it('info rows are MET without evidence', () => {
    expect(resolveStatus('info', [], null, deadline).status).toBe('MET');
  });
  it('no retrieval hit above the floor is NEEDS_EVIDENCE whatever the model said', () => {
    expect(resolveStatus('mandatory', rk(SIM.floor - 0.01), j('covers'), deadline).status).toBe('NEEDS_EVIDENCE');
    expect(resolveStatus('mandatory', [], null, deadline).status).toBe('NEEDS_EVIDENCE');
  });
  it('covers + strong match is MET with the cited evidence', () => {
    const r = resolveStatus('mandatory', rk(0.7), j('covers'), deadline);
    expect(r).toMatchObject({ status: 'MET', evidence_ids: ['evd_a'] });
  });
  it('the model saying covers is not trusted when retrieval is weak', () => {
    expect(resolveStatus('mandatory', rk(SIM.weak - 0.02), j('covers'), deadline).status).toBe('PARTIAL');
  });
  it('partial stays PARTIAL, contradicts is the only route to GAP, none is NEEDS_EVIDENCE', () => {
    expect(resolveStatus('scored', rk(0.6), j('partial'), deadline).status).toBe('PARTIAL');
    expect(resolveStatus('mandatory', rk(0.6), j('contradicts'), deadline).status).toBe('GAP');
    expect(resolveStatus('mandatory', rk(0.6), j('none'), deadline).status).toBe('NEEDS_EVIDENCE');
  });
  it('evidence that expires before the tender deadline downgrades MET to PARTIAL', () => {
    const r = resolveStatus('mandatory', rk(0.8, '2026-10-01'), j('covers'), deadline);
    expect(r.status).toBe('PARTIAL');
    expect(r.note).toContain('expires 2026-10-01');
    expect(resolveStatus('mandatory', rk(0.8, '2027-03-14'), j('covers'), deadline).status).toBe('MET');
  });
  it('cited ids the retrieval never returned are ignored (no invented evidence links)', () => {
    const r = resolveStatus('mandatory', rk(0.7, null, 'evd_a'), j('covers', ['evd_made_up']), deadline);
    expect(r.evidence_ids).toEqual(['evd_a']);
  });
  it('gate rows take their status from the code check', () => {
    const g = { ref: 'A2', lot: null, name: 'n', kind: 'turnover' as const, detail: 'd' };
    expect(statusFromGate({ ...g, status: 'pass' }).status).toBe('MET');
    expect(statusFromGate({ ...g, status: 'fail' }).status).toBe('GAP');
    expect(statusFromGate({ ...g, status: 'unknown' }).status).toBe('NEEDS_EVIDENCE');
  });
});
