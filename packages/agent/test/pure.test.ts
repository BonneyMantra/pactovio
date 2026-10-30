import { describe, expect, it } from 'vitest';
import {
  bucket, checkTokenBudget, checkTurnCap, dueCertificateNudges, dueDeadlineReminders, formatMoney, mapEvent, nextDigestAt, renderDigest, signDecision, verifyDecision, ThinkFilter,
} from '../src';

const ev = (type: string, payload: Record<string, unknown>) => ({ id: `evt_${type}`, type, payload });

describe('event to message mapping', () => {
  it('tender.matched asks to read the pack, with the fit score', () => {
    const m = mapEvent(ev('tender.matched', { tender_id: 'tnd_1', title: 'Teagasc web applications maintenance', fit_score: 86.2, buyer: 'Teagasc' }))!;
    expect(m.text).toContain('New match: Teagasc web applications maintenance, fit 86.');
    expect(m.text).toContain('Read the pack?');
    expect(m.action).toMatchObject({ tool: 'start_pack_run', input: { tender_id: 'tnd_1' }, title: 'Read the pack?' });
  });
  it('intake.classified: design request asks to start spec match; RFP asks for the pack read; ignore is silent', () => {
    const d = mapEvent(ev('intake.classified', { door: 'design', title: 'Fog monitoring for Galway port', sender: 'ops@portauthority.example', design_request_id: 'dsg_1' }))!;
    expect(d.text).toContain('Start spec match?');
    expect(d.action).toMatchObject({ tool: 'match_design_request', input: { design_request_id: 'dsg_1' } });
    const r = mapEvent(ev('intake.classified', { door: 'rfp', title: 'RFP-CCC-2026-14', tender_id: 'tnd_9' }))!;
    expect(r.text).toContain('RFP/RFQ');
    expect(r.action?.tool).toBe('start_pack_run');
    expect(mapEvent(ev('intake.classified', { door: 'ignore', title: 'newsletter' }))).toBeNull();
  });
  it('verdict.ready offers to draft answers for BID and CONDITIONAL, not for NO_BID', () => {
    expect(mapEvent(ev('verdict.ready', { tender_id: 't', title: 'T', decision: 'BID', score: 78, lot: '1' }))!.action?.input).toEqual({ tender_id: 't', lot: '1' });
    expect(mapEvent(ev('verdict.ready', { tender_id: 't', title: 'T', decision: 'NO_BID', score: 22 }))!.action).toBeUndefined();
  });
  it('approval.requested carries the answer id into approve_answer', () => {
    const m = mapEvent(ev('approval.requested', { answer_id: 'ans_1', question_ref: 'Q3.2', title: 'Teagasc' }))!;
    expect(m.action).toMatchObject({ tool: 'approve_answer', input: { answer_id: 'ans_1' } });
  });
  it('money is formatted by code, from integer minor units', () => {
    const m = mapEvent(ev('quote.ready', { total_minor: 1_234_567, currency: 'EUR', customer: 'Galway Harbour Authority' }))!;
    expect(m.text).toContain('€12,345.67');
    expect(formatMoney(-5, 'EUR')).toBe('-€0.05');
  });
  it('informational events have no action, and noise events map to nothing', () => {
    expect(mapEvent(ev('audit.completed', { status: 'completed', summary: '2 claims flagged' }))!.action).toBeUndefined();
    expect(mapEvent(ev('certificate.expiring', { title: 'ISO 27001', valid_to: '2026-12-01', days_left: 32 }))!.text).toContain('ISO 27001');
    for (const t of ['run.started', 'run.step', 'billing.updated', 'intake.received', 'answer.drafted']) expect(mapEvent(ev(t, {}))).toBeNull();
  });
  it('a tender.matched without a tender id still informs but offers no action', () => {
    const m = mapEvent(ev('tender.matched', { title: 'Unknown' }))!;
    expect(m.action).toBeUndefined();
  });
});

describe('schedule', () => {
  it('06:30 MYT is 22:30 UTC; the next digest is always in the future', () => {
    const before = Date.UTC(2026, 10, 1, 10, 0);
    expect(new Date(nextDigestAt(before)).toISOString()).toBe('2026-11-01T22:30:00.000Z');
    const after = Date.UTC(2026, 10, 1, 23, 0);
    expect(new Date(nextDigestAt(after)).toISOString()).toBe('2026-11-02T22:30:00.000Z');
    expect(nextDigestAt(Date.UTC(2026, 10, 1, 22, 30, 0))).toBe(Date.UTC(2026, 10, 2, 22, 30));
  });
  it('buckets: smallest crossed threshold, none when far or past', () => {
    expect(bucket(8, [7, 2, 1])).toBeNull();
    expect(bucket(6.5, [7, 2, 1])).toBe(7);
    expect(bucket(1.9, [7, 2, 1])).toBe(2);
    expect(bucket(0.4, [7, 2, 1])).toBe(1);
    expect(bucket(-1, [7, 2, 1])).toBeNull();
  });
  it('deadline reminders fire once per threshold', () => {
    const now = Date.UTC(2026, 10, 18, 22, 30);
    const t = [{ tender_id: 'tnd_t', title: 'Teagasc web applications maintenance', deadline: '2026-11-19T14:00:00Z' }];
    const first = dueDeadlineReminders(t, now, new Set());
    expect(first).toHaveLength(1);
    expect(first[0]!.key).toBe('deadline:tnd_t:1');
    expect(first[0]!.text).toContain('Deadline in');
    expect(dueDeadlineReminders(t, now, new Set([first[0]!.key]))).toHaveLength(0);
    expect(dueDeadlineReminders(t, Date.UTC(2026, 10, 1), new Set())).toHaveLength(0); // 18 days out
  });
  it('certificate nudges at 60/30/7 days and once when expired', () => {
    const now = Date.UTC(2026, 10, 1);
    const c = (valid_to: string) => [{ evidence_id: 'evd_1', title: 'ISO 27001 certificate', valid_to }];
    expect(dueCertificateNudges(c('2027-06-01'), now, new Set())).toHaveLength(0);
    expect(dueCertificateNudges(c('2026-12-20'), now, new Set())[0]!.key).toBe('cert:evd_1:60');
    expect(dueCertificateNudges(c('2026-11-20'), now, new Set())[0]!.key).toBe('cert:evd_1:30');
    expect(dueCertificateNudges(c('2026-10-20'), now, new Set())[0]!.text).toContain('expired');
  });
  it('digest text comes from the data and offers the top new match', () => {
    const d = renderDigest({
      new_matches: 3, open_intakes: 2, answers_awaiting_approval: 1,
      top_matches: [{ tender_id: 'tnd_a', title: 'Teagasc web applications maintenance', fit_score: 86, status: 'new', deadline: null }],
      closing_soon: [{ tender_id: 'tnd_a', title: 'Teagasc web applications maintenance', deadline: '2026-11-19T14:00:00Z', days_left: 4 }],
      expiring_certificates: [],
    }, 'Harbour Digital Ltd', Date.UTC(2026, 10, 14, 22, 30));
    expect(d.text).toContain('3 new matches, 2 open intakes, 1 answer awaiting your approval');
    expect(d.text).toContain('2026-11-15');
    expect(d.action?.tool).toBe('start_pack_run');
  });
});

describe('caps', () => {
  it('10 turns per minute per session: the 11th is refused with a retry time', () => {
    const now = 1_000_000;
    const stamps = Array.from({ length: 10 }, (_, i) => now - 50_000 + i * 1000);
    expect(checkTurnCap(stamps.slice(0, 9), now).ok).toBe(true);
    const r = checkTurnCap(stamps, now);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(r.retryAfterSec).toBeLessThanOrEqual(60);
  });
  it('old turns fall out of the window', () => {
    const now = 1_000_000;
    expect(checkTurnCap(Array.from({ length: 10 }, () => now - 61_000), now).ok).toBe(true);
  });
  it('token budget', () => {
    expect(checkTokenBudget(149_999).ok).toBe(true);
    expect(checkTokenBudget(150_000).ok).toBe(false);
  });
});

describe('signed approval links', () => {
  it('verifies only the exact workspace, action, decision and token', async () => {
    const t = await signDecision('s3cret', 'ws_a', 'act_1', 'confirm');
    expect(await verifyDecision('s3cret', 'ws_a', 'act_1', 'confirm', t)).toBe(true);
    expect(await verifyDecision('s3cret', 'ws_a', 'act_1', 'decline', t)).toBe(false);
    expect(await verifyDecision('s3cret', 'ws_b', 'act_1', 'confirm', t)).toBe(false);
    expect(await verifyDecision('s3cret', 'ws_a', 'act_2', 'confirm', t)).toBe(false);
    expect(await verifyDecision('other', 'ws_a', 'act_1', 'confirm', t)).toBe(false);
    expect(await verifyDecision('s3cret', 'ws_a', 'act_1', 'confirm', 'short')).toBe(false);
  });
});

describe('ThinkFilter', () => {
  it('drops <think> spans even when tags are split across chunks', () => {
    const f = new ThinkFilter();
    const out = ['Hel', 'lo <thi', 'nk>secret reasoning</th', 'ink> world', '!'].map((c) => f.push(c)).join('') + f.flush();
    expect(out).toBe('Hello  world!');
  });
  it('keeps a lone "<" that is not a tag', () => {
    const f = new ThinkFilter();
    expect(f.push('a < b') + f.flush()).toBe('a < b');
  });
});
