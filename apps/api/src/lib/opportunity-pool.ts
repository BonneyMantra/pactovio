import { fromRow, type Tender } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import {
  domainOfCpv, domainsFromText, fetchSource, NOTICE_SOURCES, WB_GROUP_DOMAIN, type Domain, type NoticeSource, type PoolTender,
} from '@pactovio/sources';

/** A notice as the reader sees it: source is one of the four public sources (eTenders-portal TED notices read as TED). */
export type ViewTender = Omit<PoolTender, 'source'> & { source: NoticeSource };
const POOL_TTL_SECONDS = 1800;
const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(12000) });

export function asView(t: PoolTender): ViewTender | null {
  if (t.source === 'etenders') {
    const pub = typeof t.raw?.ted_publication_number === 'string' ? t.raw.ted_publication_number : null;
    return pub ? { ...t, source: 'ted', source_ref: pub } : null;
  }
  return t.source === 'upload' ? null : { ...t, source: t.source };
}
export const viewKey = (t: { source: string; source_ref: string }) => `${t.source}:${t.source_ref}`;

/** CPV families, World Bank procurement group and (for CPV-less notices) title keywords. */
export function noticeDomains(t: PoolTender): Domain[] {
  const out = new Set<Domain>();
  for (const c of t.cpv) { const d = domainOfCpv(c); if (d) out.add(d); }
  if (!t.cpv.length) {
    const desc = typeof t.raw?.description === 'string' ? t.raw.description.slice(0, 800) : '';
    for (const d of domainsFromText(`${t.title} ${desc}`)) out.add(d);
    const group = WB_GROUP_DOMAIN[String(t.raw?.procurement_group ?? '')];
    if (group) out.add(group);
  }
  return [...out];
}

const poolKey = (s: NoticeSource, domains: Domain[]) => (s === 'ted' ? `opp:pool:v2:ted:${[...domains].sort().join(',')}` : `opp:pool:v2:${s}`);

/** One source, cached 30 min in KV (public data shared by every workspace). Failures are reported, never cached. */
export async function sourcePool(env: Env, source: NoticeSource, domains: Domain[], now: Date): Promise<{ tenders: PoolTender[]; failed: boolean }> {
  const key = poolKey(source, domains);
  try {
    const hit = await env.CACHE.get(key);
    if (hit) return { tenders: JSON.parse(hit) as PoolTender[], failed: false };
  } catch { /* miss */ }
  try {
    const open = (await fetchSource(source, { domains, now, fetch: timed })).filter((t) => !t.deadline || Date.parse(t.deadline) > now.getTime());
    await env.CACHE.put(key, JSON.stringify(open), { expirationTtl: POOL_TTL_SECONDS }).catch(() => undefined);
    return { tenders: open, failed: false };
  } catch {
    return { tenders: [], failed: true };
  }
}

async function storedNotices(env: Env, now: Date): Promise<Tender[]> {
  // Seeded demo notices (raw.sample) belong to the sample workspace, not to a customer's search.
  const res = await env.DB.prepare(`SELECT * FROM tenders WHERE source IN ('ted','fts','etenders','cf','wb') AND (deadline IS NULL OR deadline > ?)
    AND COALESCE(json_extract(raw_json, '$.sample'), 0) != 1 ORDER BY published_at DESC LIMIT 400`).bind(now.toISOString()).all<Record<string, unknown>>();
  return res.results.map((r) => fromRow<Tender>(r));
}

/** Stored nightly notices plus every live source; later (live) copies replace stored ones with the same key. */
export async function loadPool(env: Env, domains: Domain[], now: Date): Promise<{ pool: ViewTender[]; failed: NoticeSource[] }> {
  const live = await Promise.all(NOTICE_SOURCES.map((s) => sourcePool(env, s, domains, now)));
  const byKey = new Map<string, ViewTender>();
  for (const t of [...await storedNotices(env, now), ...live.flatMap((l) => l.tenders)]) {
    const v = asView(t);
    if (v && (!v.deadline || Date.parse(v.deadline) > now.getTime())) byKey.set(viewKey(v), v);
  }
  return { pool: [...byKey.values()], failed: NOTICE_SOURCES.filter((_, i) => live[i]!.failed) };
}

/** A pooled notice by id (Contracts Finder has no fetch-by-id API, so its reader uses the cached pool). */
export async function findPooled(env: Env, source: NoticeSource, id: string, domains: Domain[], now = new Date()): Promise<ViewTender | null> {
  const { tenders } = await sourcePool(env, source, domains, now);
  for (const t of tenders) { const v = asView(t); if (v && v.source === source && v.source_ref === id) return v; }
  return null;
}
