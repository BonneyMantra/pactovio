import { searchContractsFinder } from './contracts-finder';
import { searchFts } from './fts';
import { DOMAIN_CPV, type Domain } from './regions';
import { buildTedQuery, searchTed } from './ted';
import { NOTICE_SOURCES, type FetchFn, type NoticeSource, type PoolTender } from './types';
import { searchWorldBank } from './worldbank';

/**
 * Worldwide onboarding pool: TED (every buyer country, CPV families of the chosen domains), UK Find a Tender, UK Contracts
 * Finder and World Bank procurement notices. Sources run in parallel; each failure is reported per source, never fatal.
 * Not included (documented gaps): AusTender's OCDS API publishes awarded contracts only, CanadaBuys open data answered 403,
 * SAM.gov needs an API key.
 */
export interface WorldwideOptions { domains: Domain[]; now?: Date; sinceDays?: number; fetch?: FetchFn; tedPages?: number }
export interface SourceFailure { source: NoticeSource; message: string }

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** One source of the worldwide pool. TED is scoped by the domains' CPV families; the others return every category. */
export async function fetchSource(source: NoticeSource, o: WorldwideOptions): Promise<PoolTender[]> {
  const now = o.now ?? new Date(), since = isoDay(new Date(now.getTime() - (o.sinceDays ?? 14) * DAY));
  if (source === 'fts') return searchFts({ updatedFrom: `${since}T00:00:00`, limit: 100, fetch: o.fetch });
  if (source === 'cf') return searchContractsFinder({ publishedFrom: `${since}T00:00:00`, limit: 100, fetch: o.fetch });
  if (source === 'wb') return searchWorldBank({ rows: 100, fetch: o.fetch });
  const cpvPrefixes = [...new Set(o.domains.flatMap((d) => DOMAIN_CPV[d]))];
  if (!cpvPrefixes.length) return [];
  const query = buildTedQuery({ since, cpvPrefixes, countries: [] });
  const out: PoolTender[] = [];
  for (let page = 1; page <= (o.tedPages ?? 3); page++) {
    const got = await searchTed({ query, limit: 100, page, fetch: o.fetch });
    out.push(...got);
    if (got.length < 100) break;
  }
  return out;
}

/** All sources in parallel; each failure is reported per source and never fails the others. */
export async function fetchWorldwide(o: WorldwideOptions): Promise<{ tenders: PoolTender[]; failed: SourceFailure[] }> {
  const sources = NOTICE_SOURCES;
  const settled = await Promise.allSettled(sources.map((s) => fetchSource(s, o)));
  const tenders: PoolTender[] = [], failed: SourceFailure[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') tenders.push(...s.value);
    else failed.push({ source: sources[i]!, message: s.reason instanceof Error ? s.reason.message.slice(0, 160) : 'failed' });
  });
  return { tenders, failed };
}
