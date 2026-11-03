import { fromRow, HttpError, newId, type Tender } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import {
  fetchFtsDetail, fetchTedDetail, NoticeNotFound, poolDetail, searchWorldBank, SEGMENT_DOMAINS, upsertTenders, type NoticeDetail, type NoticeSource,
} from '@pactovio/sources';
import type { OnboardingState } from './onboarding-state';
import { patchData } from './onboarding-state';
import { assessmentKey, assessNotices, profileHash, readAssessment } from './opportunity-assess';
import { saveTenderDates, tenderDates } from './opportunity-deadlines';
import { toNotice } from './opportunity-notice';
import { asView, findPooled, type ViewTender } from './opportunity-pool';

const DETAIL_TTL_SECONDS = 6 * 3600;
const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(12000) });
const domainsOf = (state: OnboardingState) => SEGMENT_DOMAINS[state.company.supplier_segment ?? 'industrial'];

async function storedTender(env: Env, source: NoticeSource, id: string): Promise<Tender | null> {
  if (source !== 'ted' && source !== 'fts') return null;
  const row = await env.DB.prepare('SELECT * FROM tenders WHERE source = ? AND source_ref = ?').bind(source, id).first<Record<string, unknown>>();
  return row ? fromRow<Tender>(row) : null;
}

async function liveDetail(env: Env, state: OnboardingState, source: NoticeSource, id: string): Promise<NoticeDetail> {
  if (source === 'ted') return fetchTedDetail(id, timed);
  if (source === 'fts') return fetchFtsDetail(id, timed);
  if (source === 'wb') {
    const [hit] = await searchWorldBank({ id, rows: 1, fetch: timed });
    if (!hit || hit.source_ref !== id) throw new NoticeNotFound(id);
    return poolDetail(hit);
  }
  const pooled = await findPooled(env, 'cf', id, domainsOf(state));
  if (!pooled) throw new NoticeNotFound(id); // Contracts Finder has no fetch-by-id API; its notices come from the cached pool
  return poolDetail(pooled);
}

/** Live source detail, cached 6 h (public data). Falls back to the stored nightly row, marked partial. */
export async function loadDetail(env: Env, state: OnboardingState, source: NoticeSource, id: string): Promise<{ detail: NoticeDetail; partial: boolean }> {
  const key = `oppd:v1:${source}:${id}`;
  try {
    const hit = await env.CACHE.get(key);
    if (hit) return { detail: JSON.parse(hit) as NoticeDetail, partial: false };
  } catch { /* cache miss */ }
  try {
    const detail = await liveDetail(env, state, source, id);
    await env.CACHE.put(key, JSON.stringify(detail), { expirationTtl: DETAIL_TTL_SECONDS }).catch(() => undefined);
    return { detail, partial: false };
  } catch (e) {
    const stored = await storedTender(env, source, id);
    if (stored) return { detail: poolDetail(stored), partial: true };
    if (e instanceof NoticeNotFound) throw new HttpError(404, 'This notice was not found at the source.', 'not_found');
    throw new HttpError(503, 'The tender source is not answering right now. Try again shortly.', 'sources_unavailable');
  }
}

/** eTenders-portal TED notices are stored as source 'etenders'; the reader and cache keep the id the user opened. */
const viewed = (t: NoticeDetail['tender'], source: NoticeSource, id: string): ViewTender => ({ ...(asView(t) ?? t), source, source_ref: id } as ViewTender);

export async function opportunityDetail(env: Env, state: OnboardingState, source: NoticeSource, id: string, lang: string) {
  const now = new Date();
  const { detail, partial } = await loadDetail(env, state, source, id);
  const view = viewed(detail.tender, source, id);
  const forModel = { ...view, raw: { ...(view.raw ?? {}), description: (detail.description ?? '').slice(0, 1500) || view.raw?.description } };
  const { byKey, keys, ai } = await assessNotices(env, state, [forModel], lang);
  const notice = toNotice(view, byKey.get(keys[0]!) ?? null, lang, now, state.company.supplier_segment, detail.exact_cpv_labels);
  return {
    ...notice, ...(detail.original_language ? { original_language: detail.original_language } : {}),
    ...(detail.description ? { description: detail.description } : {}), lots: detail.lots,
    ...(detail.estimated_value ? { estimated_value: detail.estimated_value } : {}), key_dates: detail.key_dates, buyer_contact: detail.buyer,
    ...(detail.documents_url ? { documents_url: detail.documents_url } : {}), ...(detail.submission_url ? { submission_url: detail.submission_url } : {}),
    award_criteria: detail.award_criteria, saveable: true, partial, ai, fetched_at: now.toISOString(),
  };
}

/** "Assess more": translate + score specific notices (<= 20) from the pool, stored rows or the live detail. */
export async function assessByIds(env: Env, state: OnboardingState, ids: string[], lang: string) {
  const now = new Date(), found: ViewTender[] = [], missing: string[] = [];
  for (const ref of [...new Set(ids)]) {
    const [source, id] = [ref.slice(0, ref.indexOf(':')) as NoticeSource, ref.slice(ref.indexOf(':') + 1)];
    const pooled = await findPooled(env, source, id, domainsOf(state), now);
    if (pooled) { found.push(pooled); continue; }
    try { found.push(viewed((await loadDetail(env, state, source, id)).detail.tender, source, id)); } catch { missing.push(ref); }
  }
  const { byKey, keys, ai } = await assessNotices(env, state, found, lang);
  return { notices: found.map((t, i) => toNotice(t, byKey.get(keys[i]!) ?? null, lang, now, state.company.supplier_segment)), missing, ai, lang };
}

const LABEL: Record<string, string> = { ted: 'TED (saved in setup)', fts: 'Find a Tender (saved in setup)', cf: 'Contracts Finder (saved in setup)', wb: 'World Bank (saved in setup)' };

/** Save an AI-assessed notice into tenders + tender_matches (+ the nightly scan's intake) and write its key dates as deadlines. */
export async function saveOpportunity(env: Env, ws: string, state: OnboardingState, source: NoticeSource, id: string, lang: string) {
  const hash = await profileHash(state);
  const a = await readAssessment(env, assessmentKey(source, id, lang, hash)) ?? (lang === 'en' ? null : await readAssessment(env, assessmentKey(source, id, 'en', hash)));
  if (!a) throw new HttpError(409, 'Only AI-assessed notices can be saved. Search again when AI assessment is available.', 'not_assessed');
  const db = env.DB, at = new Date().toISOString(), fit = Math.round(a.score), reason = a.reasons.join(' ').slice(0, 1000);
  const { detail } = await loadDetail(env, state, source, id);
  let tenderId = (await storedTender(env, source, id))?.id;
  if (!tenderId) tenderId = (await upsertTenders(env, [detail.tender as Tender]))[0]!.id;
  await db.batch([
    db.prepare(`INSERT INTO tender_matches (workspace_id, tender_id, fit_score, fit_reason, status, created_at) VALUES (?, ?, ?, ?, 'new', ?)
      ON CONFLICT(workspace_id, tender_id) DO UPDATE SET fit_score = excluded.fit_score, fit_reason = excluded.fit_reason,
      status = CASE WHEN tender_matches.status = 'dismissed' THEN 'new' ELSE tender_matches.status END`).bind(ws, tenderId, fit, reason, at),
    db.prepare(`INSERT INTO intakes (id, workspace_id, door, source, title, sender, received_at, status, classification_json, tender_id)
      SELECT ?, ?, 'tender', 'scan', (SELECT substr(buyer || ': ' || title, 1, 200) FROM tenders WHERE id = ?), ?, ?, 'classified', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM intakes WHERE workspace_id = ? AND tender_id = ?)`)
      .bind(newId('intake'), ws, tenderId, LABEL[source], at, JSON.stringify({ door: 'tender', confidence: fit / 100, reason }), tenderId, ws, tenderId),
  ]);
  const dates = tenderDates(detail, source, id);
  await saveTenderDates(db, ws, tenderId, `${detail.tender.buyer}: ${detail.tender.title}`, dates);
  const match = await db.prepare('SELECT status, fit_score FROM tender_matches WHERE workspace_id = ? AND tender_id = ?').bind(ws, tenderId)
    .first<{ status: string; fit_score: number }>();
  const prior = (state.results.opportunities as { saved?: unknown } | undefined)?.saved;
  const saved = [...(Array.isArray(prior) ? prior as { source: string; id: string }[] : []).filter((x) => !(x.source === source && x.id === id)),
    { source, id, tender_id: tenderId, fit_score: fit, at }].slice(-50);
  const total = await db.prepare('SELECT COUNT(*) AS n FROM workspace_deadlines WHERE workspace_id = ?').bind(ws).first<{ n: number }>();
  await patchData(db, ws, { results: { opportunities: { saved }, deadlines: { count: total?.n ?? 0, at } } });
  return { tender_id: tenderId, status: match?.status ?? 'new', fit_score: fit, deadlines: dates.map(({ kind, title, due_at }) => ({ kind, title, due_at })), saved };
}
