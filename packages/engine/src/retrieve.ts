import { newId, type CompanyProfile, type Evidence } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { embed, modelFor, rankByCosine, type StepLogger } from '@pactovio/models';
import { EMBED_DIMS } from './types';
import { eurFromMinor, mapLimit } from './util';

/** Embedding batches of 32 run 4 at a time; the whole call is logged as ONE run_step. */
export async function embedParallel(texts: string[], o: { env: Env; purpose: string; onStep?: StepLogger; fetch?: typeof fetch }): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 32) batches.push(texts.slice(i, i + 32));
  const agg = { tokensIn: 0, cost: 0 };
  const t0 = Date.now();
  const out = await mapLimit(batches, 4, (b) => embed(b, { env: o.env, role: 'embed', purpose: o.purpose, fetch: o.fetch, onStep: (s) => { agg.tokensIn += s.tokensIn; agg.cost += s.costUsd; } }));
  await o.onStep?.({ purpose: o.purpose, model: modelFor(o.env, 'embed'), status: 'ok', tokensIn: agg.tokensIn, tokensOut: 0, tokensCached: 0, ms: Date.now() - t0, costUsd: Number(agg.cost.toFixed(6)), summary: `${texts.length} texts in ${batches.length} parallel batch(es)` });
  return out.flat();
}

export interface ChunkRef { id: string; evidenceId: string; text: string; embedding: number[]; title: string; validTo: string | null; kind: string }

/** Split text into chunks of about `maxWords` words on sentence boundaries. Short texts stay whole. */
export function chunkText(text: string, maxWords = 120): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) ?? [];
  const chunks: string[] = [];
  let cur: string[] = [];
  let n = 0;
  for (const s of sentences) {
    const w = s.trim().split(/\s+/).length;
    if (n + w > maxWords && cur.length) { chunks.push(cur.join(' ').trim()); cur = []; n = 0; }
    cur.push(s.trim());
    n += w;
  }
  if (cur.length) chunks.push(cur.join(' ').trim());
  return chunks.filter(Boolean);
}

const round = (v: number[]) => v.slice(0, EMBED_DIMS).map((x) => Number(x.toFixed(5)));

/**
 * The company profile is evidence too: services, staffing, insurance, turnover and references become
 * `evidence` rows (idempotent ids) so matrix rows and answers can cite them like any uploaded document.
 */
export async function ensureProfileEvidence(env: Env, workspaceId: string, p: CompanyProfile): Promise<number> {
  const rows: { key: string; kind: string; title: string; text: string }[] = [
    { key: 'services', kind: 'profile', title: 'Company profile: services and capabilities', text: `${p.legal_name} provides: ${p.services.join('; ')}. Technical capabilities: ${p.capabilities.join('; ')}.` },
    { key: 'staff', kind: 'profile', title: 'Company profile: staffing and sites', text: `${p.legal_name} employs ${p.staff.total} staff${p.founded ? `, founded in ${p.founded}` : ''}: ${Object.entries(p.staff.by_role).map(([r, n]) => `${n} ${r.replace(/_/g, ' ')}`).join(', ')}. Sites: ${p.sites.map((s) => `${s.city} (${s.role})`).join('; ')}.` },
  ];
  if (p.insurance) {
    const i = p.insurance;
    rows.push({ key: 'insurance', kind: 'insurance', title: 'Company profile: insurance cover', text: `Public liability ${eurFromMinor(i.public_liability_minor)}; professional indemnity ${eurFromMinor(i.professional_indemnity_minor)}${i.employers_liability_minor ? `; employers liability ${eurFromMinor(i.employers_liability_minor)}` : ''}${i.cyber_minor ? `; cyber ${eurFromMinor(i.cyber_minor)}` : ''}.` });
  }
  if (p.turnover.length) rows.push({ key: 'turnover', kind: 'financial', title: 'Company profile: turnover', text: `Turnover: ${[...p.turnover].sort((a, b) => b.year - a.year).map((t) => `${t.year} ${eurFromMinor(t.amount_minor)}`).join(', ')}.` });
  p.references.forEach((r, n) => rows.push({ key: `ref${n}`, kind: 'case_study', title: `Reference: ${r.client}, ${r.title}`, text: `${r.client}: ${r.title}${r.year ? ` (${r.year})` : ''}${r.value_minor ? `, contract value ${eurFromMinor(r.value_minor)}` : ''}. ${r.summary}` }));
  p.certifications.forEach((c, n) => rows.push({ key: `cert${n}`, kind: 'certificate', title: `Certification: ${c.name}`, text: `${p.legal_name} holds ${c.name}${c.scope ? ` for ${c.scope}` : ''}${c.issuer ? `, issued by ${c.issuer}` : ''}${c.valid_to ? `, valid to ${c.valid_to}` : ''}.` }));
  let added = 0;
  for (const r of rows) {
    const id = `evd_prof_${workspaceId.replace(/^ws_/, '')}_${r.key}`;
    const res = await env.DB.prepare('INSERT OR IGNORE INTO evidence (id, workspace_id, kind, title, issuer, scope, valid_to, r2_key, text, meta_json) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)')
      .bind(id, workspaceId, r.kind, r.title, p.legal_name, r.key.startsWith('cert') ? (p.certifications[Number(r.key.slice(4))]?.valid_to ?? null) : null, r.text, JSON.stringify({ source: 'profile' })).run();
    added += res.meta.changes ?? 0;
  }
  return added;
}

/** Chunk and embed every evidence item that has no embedded chunks yet. Embeddings are cached in D1 (1024 dims, 5 decimals). */
export async function ensureEmbeddings(env: Env, workspaceId: string, o: { onStep?: StepLogger; fetch?: typeof fetch }): Promise<{ chunks: number; embedded: number }> {
  const ev = (await env.DB.prepare(`SELECT id, text FROM evidence WHERE workspace_id = ? AND text IS NOT NULL AND text != ''`).bind(workspaceId).all<{ id: string; text: string }>()).results;
  const have = new Set((await env.DB.prepare('SELECT DISTINCT evidence_id FROM evidence_chunks WHERE workspace_id = ?').bind(workspaceId).all<{ evidence_id: string }>()).results.map((r) => r.evidence_id));
  const stmts: D1PreparedStatement[] = [];
  for (const e of ev) {
    if (have.has(e.id)) continue;
    chunkText(e.text).forEach((t, seq) => stmts.push(env.DB.prepare('INSERT INTO evidence_chunks (id, evidence_id, workspace_id, seq, text, embedding_json) VALUES (?, ?, ?, ?, ?, NULL)').bind(newId('chunk'), e.id, workspaceId, seq, t)));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  // embed "title + chunk" so a short chunk keeps the context of the document it belongs to
  const missing = (await env.DB.prepare('SELECT c.id, e.title || char(10) || c.text AS text FROM evidence_chunks c JOIN evidence e ON e.id = c.evidence_id WHERE c.workspace_id = ? AND c.embedding_json IS NULL').bind(workspaceId).all<{ id: string; text: string }>()).results;
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM evidence_chunks WHERE workspace_id = ?').bind(workspaceId).first<{ n: number }>())?.n ?? 0;
  if (!missing.length) return { chunks: total, embedded: 0 };
  const vecs = await embedParallel(missing.map((m) => m.text), { env, purpose: `Embed ${missing.length} evidence chunks (cached in D1)`, onStep: o.onStep, fetch: o.fetch });
  const up = missing.map((m, i) => env.DB.prepare('UPDATE evidence_chunks SET embedding_json = ? WHERE id = ?').bind(JSON.stringify(round(vecs[i]!)), m.id));
  for (let i = 0; i < up.length; i += 50) await env.DB.batch(up.slice(i, i + 50));
  return { chunks: total, embedded: missing.length };
}

export async function loadChunks(env: Env, workspaceId: string): Promise<ChunkRef[]> {
  const r = await env.DB.prepare(
    `SELECT c.id, c.evidence_id, c.text, c.embedding_json, e.title, e.valid_to, e.kind FROM evidence_chunks c
     JOIN evidence e ON e.id = c.evidence_id WHERE c.workspace_id = ? AND c.embedding_json IS NOT NULL ORDER BY c.evidence_id, c.seq`,
  ).bind(workspaceId).all<{ id: string; evidence_id: string; text: string; embedding_json: string; title: string; valid_to: string | null; kind: string }>();
  return r.results.map((x) => ({ id: x.id, evidenceId: x.evidence_id, text: x.text, embedding: JSON.parse(x.embedding_json) as number[], title: x.title, validTo: x.valid_to, kind: x.kind }));
}

export interface Ranked { chunk: ChunkRef; score: number }

/** Embed the queries (one batched call) and rank chunks by cosine in code. There is no reranker. */
export async function rankQueries(queries: string[], chunks: ChunkRef[], o: { env: Env; purpose: string; topK?: number; onStep?: StepLogger; fetch?: typeof fetch }): Promise<Ranked[][]> {
  if (!queries.length || !chunks.length) return queries.map(() => []);
  const qv = await embedParallel(queries, { env: o.env, purpose: o.purpose, onStep: o.onStep, fetch: o.fetch });
  const items = chunks.map((c) => ({ item: c, embedding: c.embedding }));
  return qv.map((v) => rankByCosine(round(v), items, o.topK ?? 4).map((r) => ({ chunk: r.item, score: r.score })));
}

export const evidenceFromChunks = (ranked: Ranked[], all: Evidence[]): Evidence[] => {
  const ids = new Set(ranked.map((r) => r.chunk.evidenceId));
  return all.filter((e) => ids.has(e.id));
};
