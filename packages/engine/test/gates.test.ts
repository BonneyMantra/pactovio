import { describe, expect, it } from 'vitest';
import type { CompanyProfile } from '@pactovio/contracts';
import { checkCertification, checkInsurance, checkReferences, checkTurnover, evaluateGate } from '../src/gates';
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

const gate = (g: Partial<GateSpec>): GateSpec => ({ lot: null, ref: 'A2', kind: 'turnover', text: 't', min_turnover_eur: null, turnover_basis: null, years: null, insurance_type: null, min_cover_eur: null, certification: null, min_references: null, doc: 'd', page: 1, ...g });

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
    expect(checkInsurance(gate({ kind: 'insurance', insurance_type: 'professional_indemnity', min_cover_eur: 6_000_000 }), profile).status).toBe('fail');
    expect(checkInsurance(gate({ kind: 'insurance', insurance_type: 'cyber', min_cover_eur: 1_000_000 }), profile).status).toBe('unknown');
  });

  it('certification matches by standard number and checks expiry against the tender deadline', () => {
    const iso = gate({ kind: 'certification', certification: 'ISO 27001' });
    expect(checkCertification(iso, profile, new Date('2026-11-19T14:00:00Z')).status).toBe('pass');
    expect(checkCertification(iso, profile, new Date('2027-06-01T00:00:00Z')).status).toBe('fail');
    expect(checkCertification(gate({ kind: 'certification', certification: 'ISO 9001' }), profile, new Date('2026-11-19T14:00:00Z')).detail).toContain('days left');
    expect(checkCertification(gate({ kind: 'certification', certification: 'ISO 14001' }), profile, new Date('2026-11-19')).status).toBe('fail');
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
  const ok = { ref: 'A', lot: null, name: 'g', kind: 'turnover', detail: '' } as const;
  const req = (status: 'MET' | 'PARTIAL' | 'GAP' | 'NEEDS_EVIDENCE', kind: 'mandatory' | 'scored' = 'mandatory', weight: number | null = null) => ({ kind, weight, status });

  it('a failed gate is NO_BID and caps the score', () => {
    const d = decide([{ ...ok, status: 'fail' }], [req('MET'), req('MET')]);
    expect(d.decision).toBe('NO_BID');
    expect(d.score).toBeLessThanOrEqual(34);
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
