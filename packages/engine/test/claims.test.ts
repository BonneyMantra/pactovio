import { describe, expect, it } from 'vitest';
import type { Evidence } from '@pactovio/contracts';
import { claimCheckSync, claimTokens, strikeUnsupported, NEEDS_EVIDENCE_TAG } from '../src/claims';

const ev = (id: string, title: string, text: string, extra: Partial<Evidence> = {}): Evidence =>
  ({ id, workspace_id: 'ws', kind: 'x', title, issuer: null, scope: null, valid_to: null, r2_key: null, text, meta: null, ...extra }) as Evidence;

const LIB = [
  ev('evd_iso', 'ISO/IEC 27001:2022 certificate', 'Harbour Digital Ltd is certified to ISO/IEC 27001:2022. Certificate valid 15 March 2024 to 14 March 2027, issued by NSAI.'),
  ev('evd_acc', 'Audited accounts', 'Turnover for the financial year 2025 was EUR 9.8 million. Staff: 64 staff including 38 engineers.'),
  ev('evd_board', 'Case study: Atlantic Technological Board', 'Maintenance for three student-facing applications with 24x5 support, take-on from the previous supplier in six weeks. 99.95% availability.'),
];
const ALLOW = { allow: ['Harbour Digital Ltd', 'Teagasc'] };

describe('claimCheck', () => {
  it('supports certification, money, headcount and dates that appear in the evidence', () => {
    const c = claimCheckSync('We hold ISO 27001 certification valid to March 2027. Turnover in 2025 was EUR 9.8 million. We employ 64 staff.', LIB, ALLOW);
    expect(c).toHaveLength(3);
    expect(c.every((x) => x.supported)).toBe(true);
    expect(c[0]!.evidence_ids).toContain('evd_iso');
    expect(c[1]!.evidence_ids).toContain('evd_acc');
  });

  it('reads money in different spellings with code arithmetic, not model arithmetic', () => {
    expect(claimTokens('revenue of €9.8m').find((t) => t.type === 'money')?.key).toBe('980000000');
    const same = claimCheckSync('Our turnover reached €9.8 million.', LIB, ALLOW)[0]!;
    expect(same.supported).toBe(true);
    const wrong = claimCheckSync('Our turnover reached €12 million.', LIB, ALLOW)[0]!;
    expect(wrong.supported).toBe(false);
  });

  it('turns number words into durations and matches them', () => {
    expect(claimCheckSync('We completed a six-week take-on.', LIB, ALLOW)[0]!.supported).toBe(true);
    expect(claimCheckSync('We completed a four-week take-on.', LIB, ALLOW)[0]!.supported).toBe(false);
  });

  it('flags an invented SLA and a certification that is not held', () => {
    const c = claimCheckSync('We provide 24x7 on-call cover. We are also certified to ISO 14001.', LIB, ALLOW);
    expect(c.map((x) => x.supported)).toEqual([false, false]);
    expect(c.every((x) => x.evidence_ids.length === 0)).toBe(true);
  });

  it('accepts a 24x5 claim only when the evidence says 24x5', () => {
    expect(claimCheckSync('Our service desk runs 24x5.', LIB, ALLOW)[0]!.supported).toBe(true);
    expect(claimCheckSync('Our service desk runs 24x7.', LIB, ALLOW)[0]!.supported).toBe(false);
  });

  it('checks client names but lets the bidder and the buyer be named', () => {
    const own = claimCheckSync('Harbour Digital Ltd will support Teagasc applications.', LIB, ALLOW);
    expect(own).toHaveLength(0);
    const board = claimCheckSync('We supported the Atlantic Technological Board for three applications.', LIB, ALLOW);
    expect(board[0]!.supported).toBe(true);
    const made = claimCheckSync('We delivered the portal for Dublin City Council.', LIB, ALLOW);
    expect(made[0]!.supported).toBe(false);
  });

  it('a sentence is supported only when EVERY claim in it is', () => {
    const c = claimCheckSync('We hold ISO 27001 and ISO 9001 certification.', LIB, ALLOW);
    expect(c[0]!.supported).toBe(false);
  });

  it('flags an invented product or technology the evidence never mentions (ArcGIS), keeps a documented one', () => {
    const lib = [...LIB, ev('evd_stack', 'Company profile: capabilities', 'Technical capabilities: .NET 8; Java 21 / Spring; React and TypeScript; PostgreSQL and SQL Server.')];
    expect(claimCheckSync('We have supported ArcGIS Enterprise geodatabases for years.', lib, ALLOW)[0]!.supported).toBe(false);
    expect(claimCheckSync('Our engineers work in TypeScript and PostgreSQL.', lib, ALLOW)[0]!.supported).toBe(true);
    expect(claimCheckSync('We run Java 21 services.', lib, ALLOW)[0]!.supported).toBe(true);
    expect(claimCheckSync('We run Java 8 services.', lib, ALLOW)[0]!.supported).toBe(false);
  });

  it('ignores sentences that make no checkable claim', () => {
    expect(claimCheckSync('We will start with a joint planning workshop. Our approach is incremental.', LIB, ALLOW)).toEqual([]);
  });

  it('strikes unsupported sentences and leaves a NEEDS_EVIDENCE flag, keeping supported ones', () => {
    const draft = 'We hold ISO 27001 certification. We provide 24x7 on-call cover across all lots.';
    const claims = claimCheckSync(draft, LIB, ALLOW);
    const out = strikeUnsupported(draft, claims);
    expect(out).toContain('We hold ISO 27001 certification.');
    expect(out).not.toContain('on-call cover');
    expect(out).toContain('sla 24x7');
    expect(out).toContain(NEEDS_EVIDENCE_TAG);
  });
});
