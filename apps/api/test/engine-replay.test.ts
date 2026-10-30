import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { inlineStep, runReplay, type RunCtx } from '@pactovio/engine';
import { REPLAYS } from '../../../packages/engine/replay';
import { makeEnv } from './helpers';

const HARBOUR = 'ws_harbour_digital';
const TEAGASC = 'tnd_sample_teagasc_p4941';
let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => ({ env, dispose } = await makeEnv()), 60_000);
afterAll(async () => dispose?.());

async function newRun(replay = true): Promise<RunCtx> {
  const runId = newId('run');
  await env.DB.prepare("INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at, replay) VALUES (?, ?, 'tender', ?, 'pack_run', 'queued', ?, ?)").bind(runId, HARBOUR, TEAGASC, new Date().toISOString(), replay ? 1 : 0).run();
  return { env, runId, workspaceId: HARBOUR, tenderId: TEAGASC };
}
const steps = async (runId: string) => (await env.DB.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq').bind(runId).all<Record<string, string | number | null>>()).results;

describe('replay mode', () => {
  it('the bundled Teagasc recording is a real run: Ultra steps with cached tokens, three verdicts, drafts, the matrix', () => {
    const rec = REPLAYS[TEAGASC]!;
    expect(rec.workspace_id).toBe(HARBOUR);
    expect(rec.steps.length).toBeGreaterThan(50);
    expect(rec.steps.some((x) => String(x.model).includes('Ultra') && x.tokens_cached > 50_000 && x.tokens_in > 100_000)).toBe(true);
    expect(rec.steps.every((x) => x.status === 'ok')).toBe(true);
    expect(rec.verdicts).toHaveLength(3);
    expect(rec.requirements.length).toBeGreaterThan(100);
    expect(rec.answers.length).toBeGreaterThan(5);
    expect(JSON.stringify(rec)).not.toMatch(/tvly-|api[_-]?key|Bearer /i);
  });

  it('serves the seeded showcase run when no recording is bundled: real recorded steps, labelled, totals preserved, no model called', async () => {
    const bundled = REPLAYS[TEAGASC];
    delete REPLAYS[TEAGASC];
    const rc = await newRun();
    try { await runReplay(rc, inlineStep); } finally { REPLAYS[TEAGASC] = bundled!; }
    const run = (await env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(rc.runId).first<Record<string, number | string>>())!;
    expect(run).toMatchObject({ status: 'completed', replay: 1 });
    const st = await steps(rc.runId);
    expect(st[0]!.purpose).toBe('Replay of a recorded live run');
    const recorded = await steps('run_sample_teagasc');
    expect(st.slice(1).map((s) => [s.purpose, s.model, s.tokens_in, s.tokens_out, s.tokens_cached, s.ms])).toEqual(recorded.map((s) => [s.purpose, s.model, s.tokens_in, s.tokens_out, s.tokens_cached, s.ms]));
    expect(Number(run.tokens_in)).toBe(recorded.reduce((a, s) => a + Number(s.tokens_in), 0));
  }, 20_000);

  it('restores a bundled recording (matrix, verdicts, drafts) and keeps approved answers', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO answers (id, workspace_id, tender_id, lot, question_ref, question, draft, claims_json, status, approved_at) VALUES ('ans_keep_me', ?, ?, '1', 'Z9', 'q', 'approved text', '[]', 'approved', '2026-10-30T00:00:00Z')").bind(HARBOUR, TEAGASC).run();
    REPLAYS[TEAGASC] = {
      tender_id: TEAGASC, workspace_id: HARBOUR, recorded_at: '2026-10-30T05:00:00Z', source_run_id: 'run_x',
      steps: [{ purpose: 'Whole-pack overview', model: 'nvidia/Nemotron-3-Ultra-550b-a55b', status: 'ok', tokens_in: 108000, tokens_out: 7000, tokens_cached: 0, ms: 21000, cost_usd: 0.08, summary: null }],
      requirements: [{ id: 'req_replayed', workspace_id: HARBOUR, tender_id: TEAGASC, lot: '1', ref: 'B1.1', text: 'Replayed requirement', kind: 'mandatory', weight: null, doc_id: 'doc_sample_teagasc_cft', page: 3, status: 'MET', evidence_ids_json: '["evd_sample_iso27001"]', note: 'n' }],
      verdicts: [{ id: 'vrd_replayed', workspace_id: HARBOUR, tender_id: TEAGASC, lot: '1', decision: 'CONDITIONAL', score: 61, gates_json: '[]', reasons_json: '["r"]', run_id: null }],
      answers: [{ id: 'ans_replayed', workspace_id: HARBOUR, tender_id: TEAGASC, lot: '1', question_ref: 'B1.1', question: 'q', word_limit: null, draft: 'd', claims_json: '[]', status: 'draft', approved_at: null }],
    };
    try {
      const rc = await newRun();
      await runReplay(rc, inlineStep);
      const reqs = await env.DB.prepare('SELECT id FROM requirements WHERE tender_id = ? AND workspace_id = ?').bind(TEAGASC, HARBOUR).all<{ id: string }>();
      expect(reqs.results.map((r) => r.id)).toEqual(['req_replayed']);
      const v = await env.DB.prepare('SELECT decision FROM verdicts WHERE tender_id = ? AND workspace_id = ?').bind(TEAGASC, HARBOUR).all<{ decision: string }>();
      expect(v.results.map((r) => r.decision)).toEqual(['CONDITIONAL']);
      const a = (await env.DB.prepare('SELECT id FROM answers WHERE tender_id = ? AND workspace_id = ? ORDER BY id').bind(TEAGASC, HARBOUR).all<{ id: string }>()).results.map((r) => r.id);
      expect(a).toEqual(['ans_keep_me', 'ans_replayed']);
      const st = await steps(rc.runId);
      expect(st.map((s) => s.purpose)).toEqual(['Replay of a recorded live run', 'Whole-pack overview']);
      expect(st[1]).toMatchObject({ tokens_in: 108000, ms: 21000 });
    } finally {
      delete REPLAYS[TEAGASC];
    }
  }, 20_000);
});
