import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { docxBytesToPages, ingestEvidenceImpl } from '@pactovio/engine';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

const TEAGASC = 'tnd_sample_teagasc_p4941';
const TRD1 = 'doc_sample_teagasc_trd1';
let env: Env;
let dispose: () => Promise<void>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
let cookie = '';
const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), cookie, origin: 'http://localhost' } }), env, ctx);
const json = (path: string, method: string, body: unknown) => call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const tc = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const form = () => zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'word/document.xml': strToU8(`<w:document ${W}><w:body><w:tbl><w:tr>${tc('B1.1.1')}${tc('Describe take-on')}${tc('M')}<w:sdt><w:sdtPr><w:comboBox><w:listItem w:displayText="Yes" w:value="Yes"/><w:listItem w:displayText="No" w:value="No"/><w:listItem w:displayText="Partial" w:value="Partial"/></w:comboBox></w:sdtPr><w:sdtContent><w:tc><w:p><w:r><w:t>Choose an item.</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt>${tc('Insert Response')}</w:tr></w:tbl></w:body></w:document>`),
});

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  cookie = (await customerFixture(env, 'ws_harbour_digital')).cookie;
  const r2 = (await env.DB.prepare('SELECT r2_key FROM documents WHERE id = ?').bind(TRD1).first<{ r2_key: string }>())!.r2_key;
  await env.FILES.put(r2, form());
  await env.DB.prepare("UPDATE answers SET status = 'draft', approved_at = NULL WHERE id LIKE 'ans_sample%'").run(); // seed ships one approved sample answer
  await env.DB.prepare("INSERT INTO requirements (id, workspace_id, tender_id, lot, ref, text, kind, status, evidence_ids_json) VALUES ('req_t1', 'ws_harbour_digital', ?, '1', 'B1.1.1', 'Describe take-on', 'scored', 'MET', '[]')").bind(TEAGASC).run();
  await env.DB.prepare("INSERT INTO answers (id, workspace_id, tender_id, lot, question_ref, question, draft, claims_json, status) VALUES ('ans_t1', 'ws_harbour_digital', ?, '1', 'B1.1.1', 'Describe take-on', 'We take over in six weeks.', '[]', 'draft')").bind(TEAGASC).run();
}, 60_000);
afterAll(async () => dispose?.());

describe('form filling through the API', () => {
  it('refuses to fill until an answer is approved', async () => {
    const res = await json(`/api/tenders/${TEAGASC}/forms/${TRD1}/fill`, 'POST', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('validation');
  });

  it('fills the buyer\'s own DOCX with approved answers, sets Yes from the matrix, and serves the download', async () => {
    expect((await json(`/api/tenders/${TEAGASC}/answers/ans_t1`, 'PATCH', { status: 'approved' })).status).toBe(200);
    const res = await json(`/api/tenders/${TEAGASC}/forms/${TRD1}/fill`, 'POST', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { r2_key: string; download_url: string };
    expect(body.r2_key).toContain(`filled/ws_harbour_digital/${TEAGASC}/${TRD1}`);
    const dl = await call(body.download_url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('wordprocessingml');
    expect(dl.headers.get('content-disposition')).toContain('(filled).docx');
    const text = docxBytesToPages(new Uint8Array(await dl.arrayBuffer())).join('\n');
    expect(text).toContain('B1.1.1 | Describe take-on | M | Yes | We take over in six weeks.');
  });

  it('download of a form that was never filled is a 404 in the error shape', async () => {
    const res = await call(`/api/tenders/${TEAGASC}/forms/doc_sample_teagasc_trd3/filled`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'This form has not been filled yet', code: 'not_found' });
  });

  it('a form from another workspace is not downloadable (workspace isolation)', async () => {
    const previous = cookie;
    cookie = (await customerFixture(env, 'ws_kestrel_sensing')).cookie;
    expect((await call(`/api/tenders/${TEAGASC}/forms/${TRD1}/filled`)).status).toBe(404);
    cookie = previous;
  });
});

describe('evidence ingest', () => {
  const record = { title: 'Professional indemnity certificate', issuer: 'Atlantic Mutual (sample insurer)', scope: 'Professional indemnity EUR 5,000,000 per claim', valid_to: '2027-06-30', kind: 'insurance', summary: 'Professional indemnity cover of EUR 5,000,000 any one claim, policy period to 30 June 2027.', transcript: 'Professional indemnity EUR 5,000,000' };
  const seen: unknown[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const b = JSON.parse(String(init?.body ?? '{}')) as { model: string; input?: string[]; messages?: { content: unknown }[] };
    if (u.endsWith('/embeddings')) return Response.json({ object: 'list', model: b.model, data: (b.input ?? []).map((_, index) => ({ object: 'embedding', index, embedding: new Array(1024).fill(0).map((__, i) => (i === index ? 1 : 0.001)) })), usage: { prompt_tokens: 10, total_tokens: 10 } });
    seen.push(b.messages?.at(-1)?.content);
    return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: b.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(record) } }], usage: { prompt_tokens: 800, completion_tokens: 120 } });
  }) as typeof fetch;
  const e = () => ({ ...env, NEBIUS_API_KEY: 'test' }) as Env;

  it('reads a text document into an evidence record, stores the file, chunks and embeds it', async () => {
    const bytes = new TextEncoder().encode('Professional indemnity insurance schedule. Limit of indemnity EUR 5,000,000 any one claim. Policy period 1 July 2026 to 30 June 2027. Insurer: Atlantic Mutual.');
    const out = await ingestEvidenceImpl(e(), { workspaceId: 'ws_harbour_digital', filename: 'pi-schedule.txt', mime: 'text/plain', bytes }, { fetch: fake });
    expect(out.status).toBe('ready');
    const row = (await env.DB.prepare('SELECT * FROM evidence WHERE id = ?').bind(out.evidence_id).first<Record<string, string>>())!;
    expect(row).toMatchObject({ issuer: 'Atlantic Mutual (sample insurer)', valid_to: '2027-06-30', kind: 'insurance' });
    expect(await env.FILES.head(row.r2_key!)).not.toBeNull();
    const chunks = await env.DB.prepare('SELECT embedding_json FROM evidence_chunks WHERE evidence_id = ?').bind(out.evidence_id).all<{ embedding_json: string | null }>();
    expect(chunks.results.length).toBeGreaterThan(0);
    expect(chunks.results.every((c) => c.embedding_json && (JSON.parse(c.embedding_json) as number[]).length === 1024)).toBe(true);
  });

  it('sends an image scan to the vision model as an image_url part', async () => {
    seen.length = 0;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await ingestEvidenceImpl(e(), { workspaceId: 'ws_harbour_digital', filename: 'scan.png', mime: 'image/png', bytes: png, title: 'Scanned PI certificate' }, { fetch: fake });
    const content = seen[0] as { type: string; image_url?: { url: string } }[];
    expect(content.some((p) => p.type === 'image_url' && p.image_url!.url.startsWith('data:image/png;base64,'))).toBe(true);
    const row = await env.DB.prepare("SELECT title FROM evidence WHERE title = 'Scanned PI certificate'").first();
    expect(row).not.toBeNull(); // the uploader's title wins over the model's
  });

  it('rejects an unreadable or oversized file with a 400 in the error shape', async () => {
    await expect(ingestEvidenceImpl(e(), { workspaceId: 'ws_harbour_digital', filename: 'empty.txt', mime: 'text/plain', bytes: new Uint8Array(3) }, { fetch: fake })).rejects.toMatchObject({ status: 400 });
    await expect(ingestEvidenceImpl(e(), { workspaceId: 'ws_harbour_digital', filename: 'big.bin', mime: 'application/pdf', bytes: new Uint8Array(13 * 1024 * 1024) }, { fetch: fake })).rejects.toMatchObject({ status: 400 });
  });

  it('POST /api/evidence without a file is a 400 validation error', async () => {
    const res = await call('/api/evidence', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('validation');
  });
});

describe('GET /runs/:id/stream (SSE)', () => {
  it('replays landed steps as `step` events in order, then closes with `done` for a finished run, scoped to the workspace', async () => {
    const wsRun = async (ws: string, id: string) => env.DB.prepare("INSERT INTO runs (id, workspace_id, subject_type, subject_id, kind, status, started_at, replay) VALUES (?, ?, 'tender', ?, 'pack_run', 'completed', ?, 1)").bind(id, ws, TEAGASC, new Date().toISOString()).run();
    await wsRun('ws_harbour_digital', 'run_sse_1');
    for (const [seq, purpose] of [[1, 'Load pack text'], [2, 'Whole-pack overview']] as const) {
      await env.DB.prepare("INSERT INTO run_steps (id, run_id, seq, at, purpose, model, status, tokens_in, tokens_out, tokens_cached, ms, cost_usd) VALUES (?, 'run_sse_1', ?, ?, ?, NULL, 'ok', 1, 1, 0, 5, 0)").bind(`stp_sse_${seq}`, seq, new Date().toISOString(), purpose).run();
    }
    const res = await call('/api/runs/run_sse_1/stream');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const events = [...text.matchAll(/event: (\w+)\n/g)].map((m) => m[1]);
    expect(events).toEqual(['step', 'step', 'done']);
    expect(text.indexOf('Load pack text')).toBeLessThan(text.indexOf('Whole-pack overview'));
    await wsRun('ws_kestrel_sensing', 'run_sse_other');
    expect((await call('/api/runs/run_sse_other/stream')).status).toBe(404);
  });
});
