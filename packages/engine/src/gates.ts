import type { CompanyProfile } from '@pactovio/contracts';
import type { GateSpec } from './schemas';
import { eurFromMinor } from './util';

export type GateStatus = 'pass' | 'fail' | 'unknown';
export interface GateResult {
  ref: string;
  lot: string | null;
  name: string;
  kind: GateSpec['kind'];
  status: GateStatus;
  detail: string;
  /** The pack lets the tenderer meet this after award, so a failure is a condition rather than a veto. */
  remediable: boolean;
}

const INS_FIELD = {
  public_liability: 'public_liability_minor',
  professional_indemnity: 'professional_indemnity_minor',
  employers_liability: 'employers_liability_minor',
  cyber: 'cyber_minor',
} as const;
const INS_NAME = { public_liability: 'Public liability', professional_indemnity: 'Professional indemnity', employers_liability: "Employers' liability", cyber: 'Cyber' } as const;

/** All arithmetic here is integer minor units in code. The model only supplies the thresholds it read. */
export function checkTurnover(g: GateSpec, p: CompanyProfile): GateResult {
  const base = { ref: g.ref, lot: g.lot, kind: g.kind, name: `Turnover ${g.ref}`, remediable: g.remediable };
  const years = g.years ?? 3;
  if (g.min_turnover_eur == null) return { ...base, status: 'unknown', detail: 'No turnover threshold could be read from the document' };
  const latest = [...p.turnover].sort((a, b) => b.year - a.year).slice(0, years);
  if (latest.length < years) return { ...base, status: 'unknown', detail: `Profile holds ${latest.length} of the ${years} years required` };
  const need = Math.round(g.min_turnover_eur * 100);
  if (g.turnover_basis === 'each_year') {
    const low = latest.reduce((m, t) => (t.amount_minor < m.amount_minor ? t : m));
    return low.amount_minor >= need
      ? { ...base, status: 'pass', detail: `Lowest of ${years} years ${eurFromMinor(low.amount_minor)} (${low.year}) vs ${eurFromMinor(need)} required` }
      : { ...base, status: 'fail', detail: `${low.year} turnover ${eurFromMinor(low.amount_minor)} is below ${eurFromMinor(need)} required in each year` };
  }
  const avg = Math.round(latest.reduce((a, t) => a + t.amount_minor, 0) / latest.length);
  return avg >= need
    ? { ...base, status: 'pass', detail: `${years}-year average ${eurFromMinor(avg)} vs ${eurFromMinor(need)} required` }
    : { ...base, status: 'fail', detail: `${years}-year average ${eurFromMinor(avg)} is below ${eurFromMinor(need)} required` };
}

export function checkInsurance(g: GateSpec, p: CompanyProfile): GateResult {
  const type = g.insurance_type;
  const name = type ? `${INS_NAME[type]} insurance` : `Insurance ${g.ref}`;
  const base = { ref: g.ref, lot: g.lot, kind: g.kind, name, remediable: g.remediable };
  if (!type || g.min_cover_eur == null) return { ...base, status: 'unknown', detail: 'Cover type or level not readable from the document' };
  const held = p.insurance?.[INS_FIELD[type]];
  if (held == null) return { ...base, status: 'unknown', detail: `${INS_NAME[type]} cover is not recorded in the company profile` };
  const need = Math.round(g.min_cover_eur * 100);
  return held >= need
    ? { ...base, status: 'pass', detail: `Held ${eurFromMinor(held)} vs ${eurFromMinor(need)} required` }
    : { ...base, status: 'fail', detail: `Held ${eurFromMinor(held)} is below ${eurFromMinor(need)} required` };
}

const standardNumber = (s: string): string | null => /\b(\d{4,6})\b/.exec(s)?.[1] ?? null;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function checkCertification(g: GateSpec, p: CompanyProfile, asOf: Date): GateResult {
  const want = g.certification;
  const base = { ref: g.ref, lot: g.lot, kind: g.kind, name: want ? `${want} certification` : `Certification ${g.ref}`, remediable: g.remediable };
  if (!want) return { ...base, status: 'unknown', detail: 'Certification not named in the document' };
  const n = standardNumber(want);
  const cert = p.certifications.find((c) => (n ? standardNumber(c.name) === n : norm(c.name).includes(norm(want))));
  // only a numbered standard (ISO 27001) can be proven absent; a named accreditation we do not track is unverifiable, not failed
  if (!cert) return n ? { ...base, status: 'fail', detail: `${want} is not among the certifications held` } : { ...base, status: 'unknown', detail: `${want} is not recorded in the company profile, attach the document` };
  if (!cert.valid_to) return { ...base, status: 'pass', detail: `${cert.name} held, no expiry date` };
  const exp = new Date(`${cert.valid_to}T23:59:59Z`);
  if (exp < asOf) return { ...base, status: 'fail', detail: `${cert.name} expired on ${cert.valid_to}` };
  const days = Math.floor((exp.getTime() - asOf.getTime()) / 86_400_000);
  return { ...base, status: 'pass', detail: `${cert.name} valid to ${cert.valid_to}${days < 120 ? ` (${days} days left, plan the renewal)` : ''}` };
}

export function checkReferences(g: GateSpec, p: CompanyProfile, asOf: Date): GateResult {
  const base = { ref: g.ref, lot: g.lot, kind: g.kind, name: `References ${g.ref}`, remediable: g.remediable };
  if (g.min_references == null) return { ...base, status: 'unknown', detail: 'Number of references not readable from the document' };
  const from = asOf.getUTCFullYear() - (g.years ?? 3);
  const found = p.references.filter((r) => (r.year ?? 0) >= from);
  return found.length >= g.min_references
    ? { ...base, status: 'pass', detail: `${found.length} references since ${from} (${found.map((r) => r.client).join(', ')}) vs ${g.min_references} required` }
    : { ...base, status: 'fail', detail: `${found.length} references since ${from} vs ${g.min_references} required` };
}

/** Declarations (exclusion grounds, tax, health and safety) cannot be proven from a profile: they stay visible, to confirm before submission. */
export function declarationGate(g: GateSpec): GateResult {
  return { ref: g.ref, lot: g.lot, kind: g.kind, name: `${g.kind === 'exclusion' ? 'Exclusion grounds' : 'Declaration'} ${g.ref}`, status: 'pass', remediable: false, detail: `Self-declaration, confirm before submission: ${g.text.slice(0, 140)}` };
}

export function evaluateGate(g: GateSpec, p: CompanyProfile, asOf: Date): GateResult {
  switch (g.kind) {
    case 'turnover': return checkTurnover(g, p);
    case 'insurance': return checkInsurance(g, p);
    case 'certification': return checkCertification(g, p, asOf);
    case 'references': return checkReferences(g, p, asOf);
    default: return declarationGate(g);
  }
}

export const evaluateGates = (gates: GateSpec[], p: CompanyProfile, asOf: Date): GateResult[] => gates.map((g) => evaluateGate(g, p, asOf));
