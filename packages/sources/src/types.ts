import type { Tender } from '@pactovio/contracts';

export type FetchFn = typeof fetch;

/** CPV prefixes (division level) per sample segment, from the build brief. */
export const SEGMENT_CPV: Record<'it' | 'industrial', string[]> = {
  it: ['72', '48', '50300000'],
  industrial: ['38', '32', '31'],
};

/** TED buyer countries scanned nightly (ISO 3166 alpha-3). */
export const SCAN_COUNTRIES = ['IRL', 'MLT'];

export type TenderRow = Tender;

/** Every public source the onboarding search reads. All of them can be stored in `tenders` (migration 0085 added 'cf' and 'wb'). */
export const NOTICE_SOURCES = ['ted', 'fts', 'cf', 'wb'] as const;
export type NoticeSource = typeof NOTICE_SOURCES[number];
/** A fetched notice before storage: the tenders row shape, with the wider source list. */
export type PoolTender = Omit<Tender, 'source'> & { source: Tender['source'] | 'cf' | 'wb' };

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Stable buyer key used by buyer intel: lower-case ascii slug of the buyer name. */
export const buyerKey = (name: string): string =>
  slug(name.normalize('NFD').replace(/[̀-ͯ]/g, '')).slice(0, 60) || 'unknown_buyer';

export function cpvMatches(cpv: string[], prefixes: string[]): boolean {
  return cpv.some((c) => prefixes.some((p) => (p.length >= 8 ? c === p : c.startsWith(p))));
}

export function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e.toLowerCase()] ?? '';
  });
}
