import { describe, expect, it } from 'vitest';
import type { CompanyProfile } from '@pactovio/contracts';
import { checkCertification, checkInsurance, checkReferences, checkTurnover, evaluateGate } from '../src/gates';
import { normaliseOverview } from '../src/extract';
import type { GateSpec } from '../src/schemas';
import { coverageScore, decide } from '../src/matrix-rules';

const eur = (n: number) => Math.round(n * 100);
const profile = {
  legal_name: 'Harbour Digital Ltd', hq: { city: 'Cork', country: 'IE' }, sites: [], staff: { total: 64, by_role: {} },
  turnover: [{ year: 2023, amount_minor: eur(8_100_000), currency: 'EUR' }, { year: 2024, amount_minor: eur(9_000_000), currency: 'EUR' }, { year: 2025, amount_minor: eur(9_800_000), currency: 'EUR' }],
  services: [], capabilities: [],
  certifications: [{ name: 'ISO/IEC 27001:2022', valid_to: '2027-03-14' }, { name: 'ISO 9001:2015', valid_to: '2026-12-09' }],
  references: [{ client: 'Munster Regional Water Authority', title: 'Portal', year: 2024, currency: 'EUR', summary: '' }, { client: 'Atlantic Technological Board', title: 'Records', year: 2023, currency: 'EUR', summary: '' }, { client: 'Old Client', title: 'Legacy', year: 2019, currency: 'EUR', summary: '' }],
  insurance: { currency: 'EUR', public_liability_minor: eur(6_000_000), professional_indemnity_minor: eur(5_000_000) },
  regions: [], cpv_focus: [], keywords: [],
} as unknown as CompanyProfile;

const gate = (g: Partial<GateSpec>): GateSpec => ({ lot: null, ref: 'A2', kind: 'turnover', text: 't', min_turnover_eur: null, turnover_basis: null, years: null, insurance_type: null, min_cover_eur: null, certification: null, min_references: null, remediable: false, doc: 'd', page: 1, ...g });

describe('gates arithmetic (all in code, integer minor units)', () => {
  it('turnover: average of the latest 3 years against the threshold', () => {
    const r = checkTurnover(gate({ min_turnover_eur: 750_000, turnover_basis: 'average', years: 3 }), profile);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('EUR 8,966,667');
    const fail = checkTurnover(gate({ min_turnover_eur: 9_000_000, turnover_basis: 'average', years: 3 }), profile);
    expect(fail.status).toBe('fail');
  });

  it('turnover "each year" uses the lowest year, not the average', () => {
    expect(checkTurnover(gate({ min_turnover_eur: 8_500_000, turnover_basis: 'each_year', years: 3 }), profile).status).toBe('fail');
    expect(checkTurnover(gate({ min_turnover_eur: 8_000_000, turnover_basis: 'each_year', years: 3 }), profile).status).toBe('pass');
  });

  it('turnover is unknown (never a guess) with too few years in the profile or no threshold', () => {
    expect(checkTurnover(gate({ min_turnover_eur: 1, years: 5 }), profile).status).toBe('unknown');
    expect(checkTurnover(gate({ min_turnover_eur: null }), profile).status).toBe('unknown');
  });

  it('insurance compares held cover with the required limit per cover type', () => {
    expect(checkInsurance(gate({ kind: 'insurance', insurance_type: 'public_liability', min_cover_eur: 5_000_000 }), profile).status).toBe('pass');
    const short = checkInsurance(gate({ kind: 'insurance', insurance_type: 'professional_indemnity', min_cover_eur: 6_000_000, remediable: true }), profile);
    expect(short).toMatchObject({ status: 'fail', remediable: true });
    expect(short.detail).toBe('Held EUR 5,000,000 is below EUR 6,000,000 required');
    expect(checkInsurance(gate({ kind: 'insurance', insurance_type: 'cyber', min_cover_eur: 1_000_000 }), profile).status).toBe('unknown');
  });

  it('certification matches by standard number and checks expiry against the tender deadline', () => {
    const iso = gate({ kind: 'certification', certification: 'ISO 27001' });
    expect(checkCertification(iso, profile, new Date('2026-11-19T14:00:00Z')).status).toBe('pass');
    expect(checkCertification(iso, profile, new Date('2027-06-01T00:00:00Z')).status).toBe('fail');
    expect(checkCertification(gate({ kind: 'certification', certification: 'ISO 9001' }), profile, new Date('2026-11-19T14:00:00Z')).detail).toContain('days left');
    expect(checkCertification(gate({ kind: 'certification', certification: 'ISO 14001' }), profile, new Date('2026-11-19')).status).toBe('fail');
  });

  it('an unnumbered accreditation we do not track is unverifiable, never a failed veto', () => {
    const r = checkCertification(gate({ kind: 'certification', certification: 'Tax Clearance' }), profile, new Date('2026-11-19'));
    expect(r.status).toBe('unknown');
  });

  it('references count only contracts inside the look-back window', () => {
    const asOf = new Date('2026-11-19T14:00:00Z');
    expect(checkReferences(gate({ kind: 'references', min_references: 2, years: 3 }), profile, asOf).status).toBe('pass');
    expect(checkReferences(gate({ kind: 'references', min_references: 3, years: 3 }), profile, asOf).status).toBe('fail');
  });

  it('declarations stay visible and are routed by kind', () => {
    const r = evaluateGate(gate({ kind: 'exclusion', ref: 'Reg 57', text: 'No exclusion grounds apply' }), profile, new Date());
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('confirm before submission');
  });
});

describe('bid decision rules', () => {
  const ok = { ref: 'A', lot: null, name: 'g', kind: 'turnover', detail: '', remediable: false } as const;
  const req = (status: 'MET' | 'PARTIAL' | 'GAP' | 'NEEDS_EVIDENCE', kind: 'mandatory' | 'scored' = 'mandatory', weight: number | null = null) => ({ kind, weight, status });

  it('a failed gate is NO_BID and caps the score', () => {
    const d = decide([{ ...ok, status: 'fail' }], [req('MET'), req('MET')]);
    expect(d.decision).toBe('NO_BID');
    expect(d.score).toBeLessThanOrEqual(34);
  });
  it('a failed gate the buyer lets you meet after award is CONDITIONAL, not NO_BID', () => {
    const d = decide([{ ...ok, status: 'fail', remediable: true }], [req('MET'), req('MET'), req('MET')]);
    expect(d.decision).toBe('CONDITIONAL');
    expect(decide([{ ...ok, status: 'fail', remediable: false }], [req('MET'), req('MET')]).decision).toBe('NO_BID');
  });
  it('mandatory gaps make it CONDITIONAL, three of them NO_BID', () => {
    const g = [{ ...ok, status: 'pass' as const }];
    expect(decide(g, [req('MET'), req('MET'), req('MET'), req('MET'), req('GAP')]).decision).toBe('CONDITIONAL');
    expect(decide(g, [req('MET'), req('GAP'), req('GAP'), req('GAP')]).decision).toBe('NO_BID');
  });
  it('an unverifiable gate keeps a strong lot at CONDITIONAL; clean coverage is BID', () => {
    expect(decide([{ ...ok, status: 'unknown' }], [req('MET'), req('MET')]).decision).toBe('CONDITIONAL');
    expect(decide([{ ...ok, status: 'pass' }], [req('MET'), req('MET'), req('PARTIAL')]).decision).toBe('BID');
  });
  it('coverage score weights scored criteria by their award weight', () => {
    expect(coverageScore([req('MET', 'scored', 30), req('GAP', 'scored', 10)])).toBe(75);
    expect(coverageScore([])).toBe(0);
  });
});

describe('overview clean-up', () => {
  const g = (o: Partial<GateSpec>): GateSpec => ({ lot: null, ref: 'A7', kind: 'references', text: 't', min_turnover_eur: null, turnover_basis: null, years: null, insurance_type: null, min_cover_eur: null, certification: null, min_references: 2, remediable: false, doc: 'd', page: 1, ...o });
  const base = { title: 't', buyer: 'b', procedure: null, submission_deadline: null, deadlines: [], clarifications: [], forms: [] };
  it('turns "Lot 1" into "1", drops per-lot copies of an all-lots gate, and marks insurance remediable from the pack wording', () => {
    const o = normaliseOverview({ ...base, lots: [{ lot_no: 'Lot 1', title: 'a', value_eur: null, response_form_doc: null }], gates: [g({}), g({ lot: 'Lot 1' }), g({ ref: 'A4', kind: 'insurance', insurance_type: 'public_liability', min_cover_eur: 6_500_000 })] }, 'The Candidate holds, or will hold should they be successful, the following insurances');
    expect(o.lots[0]!.lot_no).toBe('1');
    expect(o.gates.map((x) => `${x.ref}:${x.lot}`)).toEqual(['A7:null', 'A4:null']);
    expect(o.gates[1]!.remediable).toBe(true);
    const strict = normaliseOverview({ ...base, lots: [], gates: [g({ ref: 'A4', kind: 'insurance' })] }, 'Cover must be in place at submission.');
    expect(strict.gates[0]!.remediable).toBe(false);
  });
  it('a tender without numbered lots (the model answers "base", sometimes with quote marks) becomes lot 1, gates included', () => {
    const o = normaliseOverview({ ...base, lots: [{ lot_no: '"base"', title: 'a', value_eur: null, response_form_doc: null }], gates: [g({ lot: '"base"' }), g({ ref: 'A9', lot: 'base' })] }, 'x');
    expect(o.lots[0]!.lot_no).toBe('1');
    expect(o.gates.map((x) => x.lot)).toEqual(['1', '1']);
    const two = normaliseOverview({ ...base, lots: [{ lot_no: '"A"', title: 'a', value_eur: null, response_form_doc: null }, { lot_no: 'B', title: 'b', value_eur: null, response_form_doc: null }], gates: [] }, 'x');
    expect(two.lots.map((l) => l.lot_no)).toEqual(['A', 'B']);
  });
});
