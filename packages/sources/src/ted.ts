import { z } from 'zod';
import type { Tender } from '@pactovio/contracts';

type Lot = Tender['lots'][number];
import { buyerKey, cpvMatches, slug, type FetchFn } from './types';

export const TED_ENDPOINT = 'https://api.ted.europa.eu/v3/notices/search';

export const TED_FIELDS = [
  'publication-number', 'notice-title', 'notice-type', 'buyer-name', 'buyer-country', 'publication-date',
  'deadline-receipt-tender-date-lot', 'deadline-receipt-tender-time-lot', 'estimated-value-lot', 'estimated-value-cur-lot',
  'total-value', 'classification-cpv', 'title-lot', 'identifier-lot', 'document-url-lot', 'description-lot', 'links',
] as const;

export interface TedSearchParams {
  /** TED expert query string, e.g. `buyer-country=IRL AND notice-type=cn-standard`. */
  query: string;
  limit?: number;
  page?: number;
  fetch?: FetchFn;
}

const Lang = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const Notice = z.object({
  'publication-number': z.string(),
  'notice-title': Lang.optional(),
  'notice-type': z.string().optional(),
  'buyer-name': Lang.optional(),
  'buyer-country': z.array(z.string()).optional(),
  'publication-date': z.string().optional(),
  'deadline-receipt-tender-date-lot': z.array(z.string()).optional(),
  'deadline-receipt-tender-time-lot': z.array(z.string()).optional(),
  'estimated-value-lot': z.array(z.string()).optional(),
  'estimated-value-cur-lot': z.array(z.string()).optional(),
  'total-value': z.number().optional(),
  'classification-cpv': z.array(z.string()).optional(),
  'title-lot': Lang.optional(),
  'identifier-lot': z.array(z.string()).optional(),
  'document-url-lot': z.array(z.string()).optional(),
  'description-lot': Lang.optional(),
  links: z.object({ html: z.record(z.string(), z.string()).optional(), xml: z.record(z.string(), z.string()).optional() }).passthrough().optional(),
});
export type TedNotice = z.infer<typeof Notice>;
const Response = z.object({ notices: z.array(z.unknown()), totalNoticeCount: z.number().optional() });

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const pick = (l: z.infer<typeof Lang> | undefined): string[] => {
  if (!l) return [];
  const v = l.eng ?? l.ENG ?? Object.values(l)[0];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

/** TED prefixes titles with "Country – Category – ". Keep the part the buyer wrote. */
export function cleanTitle(t: string): string {
  const parts = t.split(' – ');
  return (parts.length >= 3 ? parts.slice(2).join(' – ') : t).trim();
}

/** "2026-11-19+01:00" + "14:00:00+01:00" -> "2026-11-19T13:00:00.000Z". Date-only deadlines end at 23:59 local. */
export function tedDeadline(dates: string[] | undefined, times: string[] | undefined): string | null {
  const stamps = (dates ?? []).map((d, i) => {
    const date = /^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(d);
    if (!date) return null;
    const tm = /^(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(times?.[i] ?? '');
    const iso = `${date[1]}T${tm ? tm[1] : '23:59:00'}${tm?.[2] ?? date[2] ?? 'Z'}`;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }).filter((x): x is number => x !== null);
  return stamps.length ? new Date(Math.min(...stamps)).toISOString() : null;
}

const pubDate = (d: string | undefined): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(d ?? '');
  return m ? `${m[1]}T00:00:00.000Z` : null;
};

/** Irish and Maltese buyers publish packs on an eTenders (EPPS) portal: `resourceId` is the CfT id. */
export function etendersRef(urls: string[] | undefined): { host: string; resourceId: string } | null {
  for (const u of urls ?? []) {
    const m = /^https:\/\/(www\.etenders\.gov\.(?:ie|mt))\/epps\/cft\/\w+\.do\?resourceId=(\d+)/.exec(u);
    if (m) return { host: m[1]!, resourceId: m[2]! };
  }
  return null;
}

/** One TED notice -> a tenders row (id is deterministic; upsert keeps an existing row's id). */
export function mapTedNotice(raw: TedNotice): Tender {
  const n = Notice.parse(raw);
  const pub = n['publication-number'];
  const portal = etendersRef(n['document-url-lot']);
  const source = portal ? 'etenders' : 'ted';
  const sourceRef = portal ? pub.replace(/-\d{4}$/, '') : pub;
  const titles = pick(n['title-lot']);
  const ids = n['identifier-lot'] ?? [];
  const values = n['estimated-value-lot'] ?? [];
  const eur = (n['estimated-value-cur-lot'] ?? ['EUR']).every((c) => c === 'EUR');
  const lotCount = Math.max(titles.length, ids.length, values.length, 1);
  const lots: Lot[] = Array.from({ length: lotCount }, (_, i) => {
    const v = Number(values[i]);
    return {
      lot_no: String(i + 1),
      title: titles[i] ?? `Lot ${i + 1}`,
      value_eur: eur && Number.isFinite(v) ? Math.round(v) : null,
    };
  });
  const lotValues = lots.map((l) => l.value_eur).filter((v): v is number => typeof v === 'number');
  const total = n['total-value'] ?? (lotValues.length ? Math.max(...lotValues) : null);
  const cpv = [...new Set(n['classification-cpv'] ?? [])];
  const buyer = first(pick(n['buyer-name'])) ?? 'Unknown buyer';
  const title = cleanTitle(first(pick(n['notice-title'])) ?? titles[0] ?? pub);
  const lotUrl = (n['document-url-lot'] ?? [])[0] ?? null;
  const html = n.links?.html?.ENG ?? n.links?.html?.eng;
  return {
    id: `tnd_${source}_${slug(sourceRef)}`,
    source,
    source_ref: sourceRef,
    title,
    buyer,
    buyer_key: buyerKey(buyer),
    country: (n['buyer-country'] ?? [''])[0]!,
    cpv,
    value_eur: total === null ? null : Math.round(total),
    deadline: tedDeadline(n['deadline-receipt-tender-date-lot'], n['deadline-receipt-tender-time-lot']),
    url: portal ? `https://${portal.host}/epps/cft/prepareViewCfTWS.do?resourceId=${portal.resourceId}` : (html ?? lotUrl),
    lots,
    published_at: pubDate(n['publication-date']),
    raw: {
      ted_publication_number: pub,
      notice_type: n['notice-type'] ?? null,
      ...(portal ? { portal: portal.host, resource_id: portal.resourceId } : {}),
      document_urls: [...new Set(n['document-url-lot'] ?? [])],
      description: first(pick(n['description-lot']))?.slice(0, 1500) ?? null,
    },
  };
}

/** TED expert query for new open notices in the given CPV prefixes and countries (dates as YYYYMMDD). */
export function buildTedQuery(o: { since: string; cpvPrefixes: string[]; countries: string[]; noticeTypes?: string[] }): string {
  const cpv = o.cpvPrefixes.map((p) => `classification-cpv=${p.length >= 8 ? p : `${p}*`}`).join(' OR ');
  const countries = o.countries.map((c) => `buyer-country=${c}`).join(' OR ');
  const types = (o.noticeTypes ?? ['cn-standard']).map((t) => `notice-type=${t}`).join(' OR ');
  return `publication-date>=${o.since.replace(/-/g, '')} AND (${types}) AND (${countries}) AND (${cpv})`;
}

/** Search TED (v3, no key). Returns tender rows; notices that fail validation are skipped, not fatal. */
export async function searchTed(params: TedSearchParams): Promise<Tender[]> {
  const res = await (params.fetch ?? fetch)(TED_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: params.query, fields: TED_FIELDS, limit: Math.min(params.limit ?? 50, 250), page: params.page ?? 1, paginationMode: 'PAGE_NUMBER' }),
  });
  if (!res.ok) throw new Error(`TED search failed: HTTP ${res.status}`);
  const body = Response.parse(await res.json());
  const out: Tender[] = [];
  for (const raw of body.notices) {
    const ok = Notice.safeParse(raw);
    if (ok.success) out.push(mapTedNotice(ok.data));
  }
  return out;
}

export { cpvMatches };
