import { HttpError, PackText, type CompanyProfile } from '@pactovio/contracts';
import { emit } from '@pactovio/events';
import { normRef } from './docx-fill';
import { dedupeReqs, extractLot, extractOverview, normaliseOverview } from './extract';
import { evaluateGates, type GateResult } from './gates';
import { draftAnswersImpl } from './draft';
import { matchEvidence, persistRequirements } from './match';
import { buildPackBlock, loadPackText, MAX_VISION_IMAGES, readImage, type BuiltPrompt } from './pack-load';
import { ensureEmbeddings, ensureProfileEvidence, loadChunks } from './retrieve';
import { logStep, modelLogger, timedStep } from './run-log';
import { Overview, type ExtractedReq, type GateSpec } from './schemas';
import { MAX_DRAFTS_PER_LOT, type RunCtx, type Stepper } from './types';
import { nowIso } from './util';
import { writeVerdict } from './verdict';

/** Price schedules are priced by a person (or the quote lane), never drafted as prose. */
const PRICING = /\b(cost|costs|price|pricing|rate card|hourly rate|day rate|fee|fees|payment schedule|discount)\b|€/i;

const key = (rc: RunCtx, name: string) => `runs/${rc.runId}/${name}`;
const putJson = (rc: RunCtx, name: string, v: unknown) => rc.env.FILES.put(key(rc, name), JSON.stringify(v));
async function getJson<T>(rc: RunCtx, name: string): Promise<T> {
  const o = await rc.env.FILES.get(key(rc, name));
  if (!o) throw new Error(`run artifact missing: ${name}`);
  return (await o.json()) as T;
}

async function profileOf(rc: RunCtx): Promise<CompanyProfile> {
  const w = await rc.env.DB.prepare('SELECT profile_json FROM workspaces WHERE id = ?').bind(rc.workspaceId).first<{ profile_json: string }>();
  if (!w) throw new HttpError(404, 'Workspace not found', 'not_found');
  return JSON.parse(w.profile_json) as CompanyProfile;
}

/**
 * The hero flow. Every stage is a durable step; model calls log themselves as run_steps (model, tokens incl. cached, ms, cost).
 * Large artifacts go to R2 (`runs/<id>/...`) because a Workflow step result is capped at 1 MiB.
 */
export async function runPackPipeline(rc: RunCtx, step: Stepper): Promise<void> {
  const { env } = rc;
  const onStep = modelLogger(env, rc.runId, rc.workspaceId);
  const call = { env, onStep, fetch: rc.fetch };

  await step('start', async () => {
    await env.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(rc.runId).run();
    await emit(env, rc.workspaceId, 'run.started', { run_id: rc.runId, tender_id: rc.tenderId, kind: 'pack_run' });
    return true;
  });

  // 1. Pack text (lane A's extractPack, or the stored fixture) and images
  const loaded = await step('load-pack', () =>
    timedStep(env, rc.runId, rc.workspaceId, 'Load pack text', async () => {
      const { pack, source } = await loadPackText(env, rc.tenderId);
      await putJson(rc, 'pack.json', pack);
      const pages = pack.docs.reduce((a, d) => a + d.pages.length, 0);
      const chars = pack.docs.reduce((a, d) => a + d.pages.reduce((x, p) => x + p.text.length, 0), 0);
      return { value: { source, docs: pack.docs.length, pages, chars }, summary: `${pack.docs.length} documents, ${pages} pages, ${chars.toLocaleString('en-IE')} characters (${source}).` };
    }));

  // 2. Vision: Super VL reads the drawings and scans, then the whole pack becomes one stable prompt block
  const built = await step('read-images', async (): Promise<{ images: number; approxTokens: number }> => {
    const pack = PackText.parse(await getJson(rc, 'pack.json'));
    const vision: Record<string, string> = {};
    // Only real image files go to the vision model. PDF image pages (r2Key is the PDF) are listed by the pack lane but cannot be sent as-is.
    const imgs = pack.docs.flatMap((d) => d.images.filter((i) => /\.(png|jpe?g|webp|gif)$/i.test(i.r2Key)).map((i) => ({ doc: d, ...i }))).slice(0, MAX_VISION_IMAGES);
    for (const i of imgs) {
      // a drawing that cannot be read must not stop the bid: the failure is logged as a step and the run carries on
      const text = await readImage(env, { r2Key: i.r2Key, filename: i.doc.filename, onStep, fetch: rc.fetch }).catch(() => '');
      if (text) vision[i.doc.docId] = `${vision[i.doc.docId] ?? ''}${text}\n`;
    }
    const block = buildPackBlock(pack, vision);
    await putJson(rc, 'block.json', block);
    return { images: imgs.length, approxTokens: Math.round(block.text.length / 4) };
  });

  const block = async () => getJson<BuiltPrompt>(rc, 'block.json');

  // 3. Whole-pack reads: overview first (seeds the prompt cache), then one call per lot in parallel
  const overview = await step('overview', async (): Promise<Overview> => {
    const { text } = await block();
    const raw = await extractOverview({ env, pack: text, onStep, fetch: rc.fetch });
    const data = normaliseOverview(raw.data, text);
    await putJson(rc, 'overview.json', data);
    await env.DB.prepare("UPDATE tenders SET raw_json = json_set(COALESCE(raw_json, '{}'), '$.key_dates', json(?), '$.engine', json(?)) WHERE id = ?")
      .bind(JSON.stringify(data.deadlines.map((d) => ({ label: d.label, at: d.at }))), JSON.stringify({ run_id: rc.runId, forms: data.forms, clarifications: data.clarifications }), rc.tenderId).run();
    return data;
  });
  const lots = overview.lots.length ? overview.lots : [{ lot_no: '1', title: 'All requirements', value_eur: null, response_form_doc: null }];
  const perLot = await Promise.all(lots.map((l) => step(`extract-lot-${l.lot_no}`, async (): Promise<ExtractedReq[]> => {
    const { text } = await block();
    const { data } = await extractLot({ env, pack: text, onStep, fetch: rc.fetch }, l);
    // the selection criteria (A2, A4 ...) are checked as gates; drop the copies the form tables repeat per lot
    const gateRefs = new Set(overview.gates.map((g) => normRef(/^[A-Za-z]+\.?\d+(?:\.\d+)*/.exec(g.ref.trim())?.[0] ?? g.ref)));
    const reqs = dedupeReqs(data.requirements).filter((r) => !gateRefs.has(normRef(r.ref)));
    await putJson(rc, `lot-${l.lot_no}.json`, reqs);
    return reqs;
  })));

  // 4. Gates in code, requirement rows
  const gateInfo = await step('requirements', () =>
    timedStep(env, rc.runId, rc.workspaceId, 'Check gates in code and write requirement rows', async () => {
      const profile = await profileOf(rc);
      const deadline = overview.submission_deadline ? new Date(overview.submission_deadline) : null;
      const asOf = deadline && !Number.isNaN(deadline.getTime()) ? deadline : new Date();
      const specs: GateSpec[] = overview.gates;
      const results = evaluateGates(specs, profile, asOf);
      const { docs } = await block();
      const n = await persistRequirements(env, { workspaceId: rc.workspaceId, tenderId: rc.tenderId, docs, lots: Object.fromEntries(lots.map((l, i) => [l.lot_no, perLot[i]!])), gates: specs.map((spec, i) => ({ spec, result: results[i]! })) });
      const pass = results.filter((r) => r.status === 'pass').length;
      return { value: { results, deadline: asOf.toISOString(), requirements: n }, summary: `${n} requirement rows across ${lots.length} lot(s); ${specs.length} gates checked in code: ${pass} pass, ${results.filter((r) => r.status === 'fail').length} fail, ${results.filter((r) => r.status === 'unknown').length} unverifiable.` };
    }));

  // 5. Evidence: profile as evidence, embeddings cached in D1, retrieval + judgement + status rules
  await step('embed-evidence', async () => {
    await ensureProfileEvidence(env, rc.workspaceId, await profileOf(rc));
    return ensureEmbeddings(env, rc.workspaceId, { onStep, fetch: rc.fetch });
  });
  const matrix = await step('match-evidence', async () => {
    const chunks = await loadChunks(env, rc.workspaceId);
    const gateKeys = new Set(overview.gates.map((g) => `${g.lot ?? ''}|${g.ref}`));
    const out = await matchEvidence(env, { workspaceId: rc.workspaceId, tenderId: rc.tenderId, chunks, deadline: new Date(gateInfo.deadline), gateKeys, profile: await profileOf(rc), gateResults: gateInfo.results, onStep, fetch: rc.fetch });
    await logStep(env, rc.runId, rc.workspaceId, { purpose: 'Apply status rules to the matrix', model: '', status: 'ok', tokensIn: 0, tokensOut: 0, tokensCached: 0, ms: 0, costUsd: 0, summary: `MET ${out.counts.MET}, PARTIAL ${out.counts.PARTIAL}, GAP ${out.counts.GAP}, NEEDS_EVIDENCE ${out.counts.NEEDS_EVIDENCE}.` });
    return out;
  });

  // 6. Verdicts per lot (gates + decision by code, reasoning by Ultra with the pack first)
  const docNames = Object.fromEntries((await block()).docs.map((d) => [d.docId, d.filename]));
  const verdicts = await Promise.all(lots.map((l) => step(`verdict-lot-${l.lot_no}`, async () => {
    const { text } = await block();
    const gates = gateInfo.results.filter((g: GateResult) => g.lot === null || g.lot === l.lot_no);
    return writeVerdict(env, { workspaceId: rc.workspaceId, tenderId: rc.tenderId, runId: rc.runId, lot: l.lot_no, gates, pack: text, docNames, onStep, fetch: rc.fetch });
  })));
  await step('approval', async () => {
    await env.DB.prepare('DELETE FROM verdicts WHERE workspace_id = ? AND tender_id = ? AND (run_id IS NULL OR run_id != ?)').bind(rc.workspaceId, rc.tenderId, rc.runId).run();
    await emit(env, rc.workspaceId, 'approval.requested', {
      kind: 'bid_decision', tender_id: rc.tenderId, run_id: rc.runId,
      title: 'Review bid / no-bid verdicts', detail: verdicts.map((v) => `Lot ${v.lot}: ${v.decision} (${v.score}/100)`).join('; '),
      verdicts: verdicts.map((v) => ({ lot: v.lot, decision: v.decision, score: v.score })),
    });
    return true;
  });

  // 7. Drafts for the heaviest scored questions of each lot (the rest on demand)
  for (const [i, l] of lots.entries()) {
    const qs = perLot[i]!.filter((r) => r.needs_response && r.kind !== 'info' && !PRICING.test(`${r.ref} ${r.text}`)).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.kind === 'scored' ? -1 : 1)).slice(0, MAX_DRAFTS_PER_LOT);
    if (!qs.length) continue;
    await step(`draft-lot-${l.lot_no}`, async () => {
      const out = await draftAnswersImpl(env, { workspaceId: rc.workspaceId, tenderId: rc.tenderId, lot: l.lot_no, questions: qs.map((q) => ({ ref: q.ref, question: q.text, wordLimit: q.word_limit ?? undefined })) }, { runId: rc.runId, onStep, fetch: rc.fetch });
      return out.length;
    });
  }

  await step('finish', async () => {
    await env.DB.prepare("UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?").bind(nowIso(), rc.runId).run();
    const run = await env.DB.prepare('SELECT tokens_in, tokens_out, cost_usd FROM runs WHERE id = ?').bind(rc.runId).first<Record<string, number>>();
    await emit(env, rc.workspaceId, 'run.completed', { run_id: rc.runId, tender_id: rc.tenderId, status: 'completed', ...run, matrix: matrix.counts });
    return true;
  });
}

export async function failRun(rc: RunCtx, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message.slice(0, 300) : 'run failed';
  try {
    await logStep(rc.env, rc.runId, rc.workspaceId, { purpose: 'Run failed', model: '', status: 'error', tokensIn: 0, tokensOut: 0, tokensCached: 0, ms: 0, costUsd: 0, summary: msg });
    await rc.env.DB.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?").bind(nowIso(), rc.runId).run();
    await emit(rc.env, rc.workspaceId, 'run.completed', { run_id: rc.runId, tender_id: rc.tenderId, status: 'failed', error: msg });
  } catch (e) {
    console.error('engine: failRun could not record failure', e instanceof Error ? e.message : e);
  }
}

