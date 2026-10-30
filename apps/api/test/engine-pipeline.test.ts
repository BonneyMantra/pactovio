import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { inlineStep, runPackPipeline, type RunCtx } from '@pactovio/engine';
import { makeEnv } from './helpers';

const HARBOUR = 'ws_harbour_digital';
const TEAGASC = 'tnd_sample_teagasc_p4941';

// ---------- fake Token Factory: JSON-schema calls, drafting and embeddings, with realistic usage and cached tokens ----------
let calls: { kind: string; model: string }[] = [];
const vec = (text: string) => {
  const v = new Array(1024).fill(0) as number[];
  for (const w of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 1024]! += /\d/.test(w) ? 4 : /^(the|and|for|with|must|your|that|this|from|are|you|will|have)$/.test(w) ? 0.1 : 1;
  }
  // stand-in for semantic similarity: texts about the same topic share a dimension, as a real embedder would place them
  const topics: [RegExp, number][] = [[/continuity|disaster|\brto\b/i, 1000], [/penetration/i, 1001], [/take-on|take on|incumbent/i, 1002], [/service desk|24x[57]|support/i, 1003], [/27001/i, 1004]];
  for (const [re, d] of topics) if (re.test(text)) v[d]! += 14;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const completion = (model: string, content: string, usage = { prompt_tokens: 50_000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } }) =>
  Response.json({ id: 'c', object: 'chat.completion', created: 1, model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage });

const OVERVIEW = {
  title: 'Web applications maintenance (test pack)', buyer: 'Teagasc', procedure: 'Open', submission_deadline: '2026-11-19T14:00:00+00:00',
  lots: [{ lot_no: '1', title: 'Multiple web applications', value_eur: 1_250_000, response_form_doc: 'TRD1.docx' }, { lot_no: '2', title: 'Nutrient Management Planner', value_eur: 2_500_000, response_form_doc: null }],
  gates: [
    { lot: null, ref: 'A2', kind: 'turnover', text: 'Turnover of at least EUR 750,000 in each of the last three years', min_turnover_eur: 750_000, turnover_basis: 'each_year', years: 3, insurance_type: null, min_cover_eur: null, certification: null, min_references: null, remediable: false, doc: 'CFT.docx', page: 19 },
    { lot: null, ref: 'A4a', kind: 'insurance', text: 'Public liability EUR 6.5 million', min_turnover_eur: null, turnover_basis: null, years: null, insurance_type: 'public_liability', min_cover_eur: 6_500_000, certification: null, min_references: null, remediable: true, doc: 'CFT.docx', page: 19 },
    { lot: '2', ref: 'A6', kind: 'certification', text: 'ISO 27001 certification', min_turnover_eur: null, turnover_basis: null, years: null, insurance_type: null, min_cover_eur: null, certification: 'ISO 27001', min_references: null, remediable: false, doc: 'CFT.docx', page: 20 },
  ],
  deadlines: [{ label: 'Clarification queries close', at: '2026-11-05T14:00:00+00:00', doc: 'CFT.docx', page: 1 }, { label: 'Tender submission', at: '2026-11-19T14:00:00+00:00', doc: 'CFT.docx', page: 1 }],
  clarifications: [{ no: '3', query: 'Lot values?', response: 'Lot 1 EUR 1.25m', affects: 'value' }],
  forms: [{ doc: 'TRD1.docx', lot: '1', purpose: 'Response form lot 1' }],
};
const req = (ref: string, text: string, kind: string, extra: Record<string, unknown> = {}) => ({ ref, text, kind, weight: null, word_limit: null, needs_response: false, doc: 'CFT.docx', page: 7, note: null, ...extra });
const LOTS: Record<string, unknown[]> = {
  '1': [
    req('B1.1', 'Tenderer must hold current ISO 27001 certification covering the services.', 'mandatory'),
    req('B1.2', 'Provide business continuity and disaster recovery arrangements for hosted applications.', 'scored', { weight: 20, word_limit: 120, needs_response: true }),
    req('B1.3', 'Describe your approach to take-on of the applications from the incumbent supplier.', 'scored', { weight: 35, word_limit: 150, needs_response: true }),
    req('B1.4', 'Maintenance and support service desk with 24x7 support during the grazing season.', 'mandatory'),
    req('B1.5', 'Provide an annual penetration test report for hosted applications.', 'mandatory'),
    req('B1.6', 'The contract term is four years.', 'info'),
  ],
  '2': [req('B2.1', 'Tenderer must hold current ISO 27001 certification covering the services.', 'mandatory')],
};

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; input?: string[]; messages?: { content: unknown }[]; response_format?: { json_schema: { name: string } } };
  if (u.endsWith('/embeddings')) {
    calls.push({ kind: 'embed', model: body.model });
    return Response.json({ object: 'list', model: body.model, data: (body.input ?? []).map((t, index) => ({ object: 'embedding', index, embedding: vec(t) })), usage: { prompt_tokens: 100, total_tokens: 100 } });
  }
  const schema = body.response_format?.json_schema.name;
  const user = String(body.messages?.at(-1)?.content ?? '');
  calls.push({ kind: schema ?? 'text', model: body.model });
  const cached = calls.filter((c) => c.model.includes('Ultra')).length > 1 ? 40_000 : 0;
  if (schema === 'overview') return completion(body.model, JSON.stringify(OVERVIEW));
  if (schema === 'lot_sections') return completion(body.model, JSON.stringify({ sections: [{ prefix: 'B', title: 'Award criteria' }] }));
  if (schema === 'lot_requirements') return completion(body.model, JSON.stringify({ requirements: /CONTINUE/.test(user) ? [] : LOTS[/LOT (\d)/.exec(user)![1]!], has_more: false }), { prompt_tokens: 50_000, completion_tokens: 2000, prompt_tokens_details: { cached_tokens: cached } });
  if (schema === 'judgements') {
    const items = [...user.matchAll(/\[(\d+)\] REQUIREMENT: ([^\n]*)\nEVIDENCE:\n((?:- [^\n]*\n?)*)/g)];
    return completion(body.model, JSON.stringify({ judgements: items.map((m) => {
      const first = /- \((evd_[\w]+)\)/.exec(m[3]!)?.[1] ?? 'evd_none';
      const t = m[2]!;
      const coverage = /24x7/.test(t) ? 'contradicts' : /penetration/.test(t) ? 'none' : /ISO 27001|continuity|take-on/.test(t) ? 'covers' : 'partial';
      return { idx: Number(m[1]), coverage, evidence_ids: [first], note: `${coverage}: see ${first}` };
    }) }));
  }
  if (schema === 'verdict_reasons') return completion(body.model, JSON.stringify({ reasons: ['B1.4 (CFT.docx p.7): only a 24x5 desk is evidenced, subcontract 24x7 cover.', 'Attach the penetration test report before submission.'] }), { prompt_tokens: 50_000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 40_000 } });
  // drafting (fast model): one supported sentence and one invented SLA that the claim check must strike
  return completion(body.model, 'We recover hosted applications with an RTO of 4 hours and an RPO of 1 hour. We also guarantee 24x7 on-call cover across every lot.');
}) as typeof fetch;

let env: Env;
let dispose: () => Promise<void>;
const runId = newId('run');
let rc: RunCtx;

beforeAll(async () => {
  const m = await makeEnv();
  dispose = m.dispose;
  env = { ...m.env, NEBIUS_API_KEY: 'test' } as Env;
  // lane A's extractPack is not under test: the engine falls back to the stored PackText fixture
  const doc = (docId: string, filename: string, isForm = false) => ({ docId, filename: `${filename}`, kind: 'docx', isForm, pages: [{ n: 7, text: 'Take-on, continuity and hosting requirements. ISO 27001 required.' }], images: [] });
  await env.FILES.put(`fixtures/packtext/${TEAGASC}.json`, JSON.stringify({ docs: [doc('doc_sample_teagasc_cft', 'CFT.docx'), doc('doc_sample_teagasc_trd1', 'TRD1.docx', true)] }));
  await env.DB.prepare("INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at, replay) VALUES (?, ?, 'tender', ?, 'pack_run', 'queued', ?, 0)").bind(runId, HARBOUR, TEAGASC, new Date().toISOString()).run();
  rc = { env, runId, workspaceId: HARBOUR, tenderId: TEAGASC, fetch: fakeFetch };
  const quiet = console.error;
  console.error = () => undefined; // extractPack on an empty bucket logs its own failure
  try { await runPackPipeline(rc, inlineStep); } finally { console.error = quiet; }
}, 60_000);
afterAll(async () => dispose());

const all = async <T,>(sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<T>()).results;

describe('pack run pipeline with recorded model responses', () => {
  it('completes, and every model call is a run_step with model, tokens, cached tokens, ms and cost', async () => {
    const run = (await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<Record<string, number | string>>())!;
    expect(run.status).toBe('completed');
    const steps = await all<Record<string, number | string | null>>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq', runId);
    const models = steps.filter((s) => s.model);
    expect(models.length).toBeGreaterThanOrEqual(8);
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
    expect(models.some((s) => String(s.model).includes('Ultra') && Number(s.tokens_cached) > 0)).toBe(true);
    expect(models.some((s) => String(s.model).includes('Embedding'))).toBe(true);
    expect(models.every((s) => s.status === 'ok' && Number(s.cost_usd) >= 0)).toBe(true);
    expect(Number(run.tokens_in)).toBe(steps.reduce((a, s) => a + Number(s.tokens_in), 0));
    expect(steps.some((s) => String(s.purpose).startsWith('Check gates in code'))).toBe(true);
  });

  it('gates are decided in code from the workspace profile', async () => {
    const g = Object.fromEntries((await all<{ ref: string; status: string; note: string }>("SELECT ref, status, note FROM requirements WHERE tender_id = ? AND ref IN ('A2','A4a','A6')", TEAGASC)).map((r) => [r.ref, r]));
    expect(g.A2!.status).toBe('MET');
    expect(g.A2!.note).toContain('Lowest of 3 years EUR 8,100,000');
    expect(g.A4a!.status).toBe('GAP'); // holds EUR 6M, needs 6.5M
    expect(g.A6!.status).toBe('MET');
  });

  it('applies the explicit status rules to the model judgements', async () => {
    const st = Object.fromEntries((await all<{ ref: string; status: string }>("SELECT ref, status FROM requirements WHERE tender_id = ? AND lot = '1'", TEAGASC)).map((r) => [r.ref, r.status]));
    expect(st['B1.1']).toBe('MET');
    expect(st['B1.4'], JSON.stringify(st)).toBe('GAP');
    expect(st['B1.5']).toBe('NEEDS_EVIDENCE');
    expect(st['B1.6']).toBe('MET'); // info
    const ev = await all<{ evidence_ids_json: string }>("SELECT evidence_ids_json FROM requirements WHERE tender_id = ? AND ref = 'B1.1'", TEAGASC);
    expect(JSON.parse(ev[0]!.evidence_ids_json).length).toBeGreaterThan(0);
  });

  it('writes one verdict per lot: decision by rule, reasons from the model, gates recorded', async () => {
    const v = await all<{ lot: string; decision: string; score: number; gates_json: string; reasons_json: string; run_id: string }>('SELECT * FROM verdicts WHERE tender_id = ? AND workspace_id = ? ORDER BY lot', TEAGASC, HARBOUR);
    expect(v.map((x) => x.lot)).toEqual(['1', '2']);
    expect(v[0]!.decision).toBe('CONDITIONAL'); // public liability EUR 6M < EUR 6.5M, but the pack lets it be met after award
    expect(JSON.parse(v[0]!.gates_json).find((g: { name: string }) => g.name.startsWith('Public liability')).detail).toContain('can be met after award');
    expect(v.every((x) => x.run_id === runId)).toBe(true);
    expect(JSON.parse(v[0]!.reasons_json)[0]).toContain('B1.4');
    expect(JSON.parse(v[0]!.gates_json).map((g: { name: string }) => g.name).join()).toContain('Turnover A2');
  });

  it('drafts the heaviest scored answers, strikes the invented SLA, and queues an audit per draft', async () => {
    const a = await all<{ id: string; question_ref: string; draft: string; claims_json: string; word_limit: number }>("SELECT * FROM answers WHERE tender_id = ? AND lot = '1' AND id LIKE 'ans_%' AND id NOT LIKE 'ans_sample%' ORDER BY question_ref", TEAGASC);
    expect(a.map((x) => x.question_ref)).toEqual(['B1.2', 'B1.3']);
    const [bcp, takeOn] = a;
    // B1.2 retrieves the continuity evidence, so its RTO/RPO sentence is supported and kept; the invented SLA is struck
    expect(bcp!.draft).toContain('RTO of 4 hours');
    expect(bcp!.draft).not.toContain('on-call cover');
    expect(bcp!.draft).toContain('[NEEDS_EVIDENCE');
    expect((JSON.parse(bcp!.claims_json) as { supported: boolean; evidence_ids: string[] }[]).find((c) => c.supported)!.evidence_ids).toContain('evd_sample_bcp');
    // B1.3 retrieves the take-on case study, which says nothing about RTO/RPO: both sentences are struck, nothing unsupported survives
    expect(takeOn!.draft).not.toContain('RTO of 4 hours');
    expect(takeOn!.draft).not.toContain('on-call');
    expect((JSON.parse(takeOn!.claims_json) as { supported: boolean }[]).every((c) => !c.supported)).toBe(true);
    const audits = await all<{ status: string; subject_id: string }>("SELECT status, subject_id FROM audits WHERE subject_type = 'answer' AND subject_id IN (?, ?)", a[0]!.id, a[1]!.id);
    expect(audits).toHaveLength(2);
    expect(audits.every((x) => x.status === 'queued')).toBe(true);
  });

  it('emits the run, verdict, approval and draft events and records the key dates for the calendar', async () => {
    const types = (await all<{ type: string }>('SELECT type FROM events WHERE workspace_id = ?', HARBOUR)).map((e) => e.type);
    for (const t of ['run.started', 'run.step', 'verdict.ready', 'approval.requested', 'answer.drafted', 'run.completed']) expect(types).toContain(t);
    const raw = await env.DB.prepare('SELECT raw_json FROM tenders WHERE id = ?').bind(TEAGASC).first<{ raw_json: string }>();
    const kd = (JSON.parse(raw!.raw_json) as { key_dates: { label: string }[] }).key_dates.map((d) => d.label);
    expect(kd).toContain('Clarification queries close');
  });

  it('prompt-cache discipline: the pack block leads every whole-pack prompt', async () => {
    expect(calls.filter((c) => c.model.includes('Ultra')).length).toBe(1 + 2 * 2 + 2); // overview + 2 lots x (sections + requirements) + 2 verdicts
  });
});
