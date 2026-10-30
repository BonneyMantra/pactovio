import { fromRow, newId, type Tender } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { emit } from '@pactovio/events';
import type { StepRecord } from '@pactovio/models';
import { extractPack } from '@pactovio/pack';
import { fetchEtendersPack } from './etenders';
import { searchFts } from './fts';
import { bumpCounters, recordScanRun, upsertTenders } from './scan-db';
import { buildTedQuery, searchTed } from './ted';
import { lightningTriage, type TriageFn, type TriageWorkspace } from './triage';
import { cpvMatches, SCAN_COUNTRIES, SEGMENT_CPV, type FetchFn } from './types';

/** Fit score at or above which a notice becomes a match (below it is stored as dismissed so it is not re-triaged). */
export const MATCH_THRESHOLD = 50;
const DAY_MS = 86_400_000;

export interface ScanOptions {
  workspaceId?: string;
  now?: Date;
  /** How many days of TED publications to pull (default 3, overlap is harmless: upserts are idempotent). */
  sinceDays?: number;
  maxPerQuery?: number;
  maxTriagePerWorkspace?: number;
  countries?: string[];
  /** Download and extract eTenders packs for matches (default true). */
  packs?: boolean;
  fetch?: FetchFn;
  /** Test seam: replaces the Lightning call. */
  triage?: TriageFn;
}

export interface NewMatch { workspaceId: string; tenderId: string; fit: number; reason: string; title: string; buyer: string; deadline: string | null; valueEur: number | null }
export interface ScanStats {
  scanned: number;
  new_tenders: number;
  triaged: number;
  matched: number;
  packs: number;
  pack_files: number;
  errors: string[];
  matches: NewMatch[];
}

export const emptyStats = (): ScanStats => ({ scanned: 0, new_tenders: 0, triaged: 0, matched: 0, packs: 0, pack_files: 0, errors: [], matches: [] });

export async function loadWorkspaces(env: Env, only?: string): Promise<TriageWorkspace[]> {
  const res = await env.DB.prepare(`SELECT id, name, segment, profile_json FROM workspaces ${only ? 'WHERE id = ?' : ''} ORDER BY id`)
    .bind(...(only ? [only] : []))
    .all<Record<string, unknown>>();
  return res.results.map((r) => {
    const w = fromRow<{ id: string; name: string; segment: 'it' | 'industrial'; profile: TriageWorkspace['profile'] | null }>(r);
    return { id: w.id, name: w.name, segment: w.segment, profile: w.profile ?? {} };
  });
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Pull new notices for the segments present (TED per segment, UK Find a Tender once). Source failures are reported, not fatal. */
export async function fetchNotices(workspaces: TriageWorkspace[], opts: ScanOptions = {}): Promise<{ tenders: Tender[]; errors: string[] }> {
  const now = opts.now ?? new Date();
  const since = isoDay(new Date(now.getTime() - (opts.sinceDays ?? 3) * DAY_MS));
  const limit = opts.maxPerQuery ?? 100;
  const errors: string[] = [];
  const byKey = new Map<string, Tender>();
  const segments = [...new Set(workspaces.map((w) => w.segment))];
  for (const seg of segments) {
    try {
      const query = buildTedQuery({ since, cpvPrefixes: SEGMENT_CPV[seg], countries: opts.countries ?? SCAN_COUNTRIES });
      for (let page = 1; page <= 3; page++) {
        const got = await searchTed({ query, limit, page, fetch: opts.fetch });
        got.forEach((t) => byKey.set(`${t.source}|${t.source_ref}`, t));
        if (got.length < limit) break;
      }
    } catch (e) {
      errors.push(`ted ${seg}: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  try {
    const cpvPrefixes = segments.flatMap((s) => SEGMENT_CPV[s]);
    (await searchFts({ updatedFrom: `${since}T00:00:00`, limit, cpvPrefixes, fetch: opts.fetch })).forEach((t) => byKey.set(`${t.source}|${t.source_ref}`, t));
  } catch (e) {
    errors.push(`fts: ${e instanceof Error ? e.message : 'failed'}`);
  }
  return { tenders: [...byKey.values()], errors };
}

const SOURCE_LABEL: Record<string, string> = { ted: 'TED nightly scan', etenders: 'eTenders nightly scan', fts: 'Find a Tender nightly scan' };

/** Lightning triage of every unmatched, still-open notice in the workspace's CPV families. */
export async function triageWorkspace(env: Env, ws: TriageWorkspace, opts: ScanOptions = {}): Promise<ScanStats & { steps: StepRecord[]; runId: string }> {
  const now = opts.now ?? new Date();
  const started = new Date().toISOString();
  const stats = emptyStats();
  const steps: StepRecord[] = [];
  const triage = opts.triage ?? lightningTriage(env, (s) => { steps.push(s); }, opts.fetch);
  const res = await env.DB.prepare(
    `SELECT t.* FROM tenders t WHERE t.source != 'upload' AND (t.deadline IS NULL OR t.deadline > ?)
       AND NOT EXISTS (SELECT 1 FROM tender_matches m WHERE m.workspace_id = ? AND m.tender_id = t.id)
     ORDER BY t.published_at DESC LIMIT 400`,
  ).bind(now.toISOString(), ws.id).all<Record<string, unknown>>();
  const prefixes = SEGMENT_CPV[ws.segment];
  const candidates = res.results.map((r) => fromRow<Tender>(r)).filter((t) => cpvMatches(t.cpv, prefixes)).slice(0, opts.maxTriagePerWorkspace ?? 60);

  const insMatch = env.DB.prepare(`INSERT OR IGNORE INTO tender_matches (workspace_id, tender_id, fit_score, fit_reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const insIntake = env.DB.prepare(
    `INSERT INTO intakes (id, workspace_id, door, source, title, sender, received_at, status, classification_json, tender_id)
     SELECT ?, ?, ?, 'scan', ?, ?, ?, 'classified', ?, ? WHERE NOT EXISTS (SELECT 1 FROM intakes WHERE workspace_id = ? AND tender_id = ?)`,
  );
  // Lightning concurrency is capped at 4 inside `chat` (flex limiter); launch all and let it queue.
  const results = await Promise.all(candidates.map(async (t) => {
    try {
      return { t, r: await triage(ws, t) };
    } catch (e) {
      stats.errors.push(`triage ${t.source_ref}: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`);
      return null;
    }
  }));
  for (const x of results) {
    if (!x) continue;
    stats.triaged++;
    const fit = Math.round(x.r.fit_score);
    const matched = fit >= MATCH_THRESHOLD;
    const ins = await insMatch.bind(ws.id, x.t.id, fit, x.r.reason, matched ? 'new' : 'dismissed', started).run();
    if (!matched || !ins.meta.changes) continue;
    await insIntake.bind(
      newId('intake'), ws.id, x.r.door, `${x.t.buyer}: ${x.t.title}`.slice(0, 200), SOURCE_LABEL[x.t.source] ?? 'Nightly scan', started,
      JSON.stringify({ door: x.r.door, confidence: Math.round(fit) / 100, reason: x.r.reason }), x.t.id, ws.id, x.t.id,
    ).run();
    stats.matched++;
    stats.matches.push({ workspaceId: ws.id, tenderId: x.t.id, fit, reason: x.r.reason, title: x.t.title, buyer: x.t.buyer, deadline: x.t.deadline, valueEur: x.t.value_eur });
  }
  const runId = await recordScanRun(env, ws.id, isoDay(now), started, steps, false);
  return { ...stats, steps, runId };
}

/** Download and extract the pack of an eTenders notice once; a tender that already has extracted documents is left alone. */
export async function ensurePack(env: Env, tenderId: string, opts: ScanOptions = {}): Promise<{ files: number } | null> {
  const row = await env.DB.prepare('SELECT source, raw_json FROM tenders WHERE id = ?').bind(tenderId).first<{ source: string; raw_json: string | null }>();
  if (!row || row.source !== 'etenders') return null;
  const raw = (fromRow<{ raw: Record<string, unknown> | null }>({ raw_json: row.raw_json }).raw ?? {}) as { resource_id?: string; portal?: string };
  if (!raw.resource_id) return null;
  const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE tender_id = ? AND text_r2_key IS NOT NULL').bind(tenderId).first<{ n: number }>();
  if (have && have.n > 0) return null;
  const pack = await fetchEtendersPack(raw.resource_id, { bucket: env.FILES, tenderId, host: raw.portal, fetch: opts.fetch });
  if (!pack.files.length) return { files: 0 };
  await extractPack(env, { tenderId, r2Keys: pack.files.map((f) => f.r2Key) });
  return { files: pack.files.length };
}

export async function notifyMatches(env: Env, matches: NewMatch[]): Promise<void> {
  for (const m of matches) {
    const docs = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE tender_id = ?').bind(m.tenderId).first<{ n: number }>();
    await emit(env, m.workspaceId, 'tender.matched', {
      tender_id: m.tenderId, title: m.title, buyer: m.buyer, fit_score: m.fit, reason: m.reason, deadline: m.deadline, value_eur: m.valueEur, documents: docs?.n ?? 0,
    });
  }
}

export async function finishScan(env: Env, stats: ScanStats, now: Date = new Date()): Promise<void> {
  await bumpCounters(env, isoDay(now), {
    runs: 1, notices: stats.scanned, new_tenders: stats.new_tenders, triaged: stats.triaged, matched: stats.matched, packs: stats.packs, errors: stats.errors.length,
  });
}

/** Whole nightly scan in one call (tests, dev trigger). The ScanWorkflow runs the same stages as separate durable steps. */
export async function runNightlyScan(env: Env, opts: ScanOptions = {}): Promise<ScanStats> {
  const stats = emptyStats();
  const workspaces = await loadWorkspaces(env, opts.workspaceId);
  const { tenders, errors } = await fetchNotices(workspaces, opts);
  stats.errors.push(...errors);
  stats.scanned = tenders.length;
  stats.new_tenders = (await upsertTenders(env, tenders)).filter((r) => r.isNew).length;
  for (const ws of workspaces) {
    const r = await triageWorkspace(env, ws, opts);
    stats.triaged += r.triaged;
    stats.matched += r.matched;
    stats.matches.push(...r.matches);
    stats.errors.push(...r.errors);
  }
  if (opts.packs !== false) {
    for (const id of new Set(stats.matches.map((m) => m.tenderId))) {
      try {
        const p = await ensurePack(env, id, opts);
        if (p) { stats.packs++; stats.pack_files += p.files; }
      } catch (e) {
        stats.errors.push(`pack ${id}: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`);
      }
    }
  }
  await notifyMatches(env, stats.matches);
  await finishScan(env, stats, opts.now);
  return stats;
}
