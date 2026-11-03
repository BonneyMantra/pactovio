import { z } from 'zod';
import type { Tender } from '@pactovio/contracts';
import { iso2, LANG3_TO_LANG2 } from './codes';
import { FTS_ENDPOINT, mapFtsRelease } from './fts';
import { mapTedNotice, TED_ENDPOINT, TED_FIELDS, TedNoticeSchema } from './ted';
import type { FetchFn, PoolTender } from './types';

/** Full notice detail for the in-app reader. Only values the source states; unknown fields are omitted. */
export interface Money { amount_minor: number; currency: string }
export interface NoticeDetail {
  tender: PoolTender;
  original_language?: string;
  description?: string;
  lots: { id: string; title: string; description?: string; value?: Money; duration?: { value: number; unit: string } }[];
  estimated_value?: Money;
  procedure?: string;
  key_dates: { published_at?: string; tender_deadline?: string; participation_deadline?: string; opening_at?: string; enquiry_deadline?: string };
  buyer: { name: string; city?: string; postal_code?: string; country_code?: string; email?: string; phone?: string; website?: string; contact_name?: string };
  documents_url?: string;
  submission_url?: string;
  award_criteria: { type?: string; name?: string; weight?: string }[];
  exact_cpv_labels: Record<string, string>;
}
export class NoticeNotFound extends Error {}

export const TED_DETAIL_FIELDS = [...TED_FIELDS, 'description-proc', 'title-proc', 'estimated-value-proc', 'estimated-value-cur-proc',
  'estimated-value-glo', 'estimated-value-cur-glo', 'buyer-city', 'buyer-post-code', 'buyer-email', 'organisation-tel-buyer',
  'buyer-internet-address', 'submission-url-lot', 'duration-period-value-lot', 'duration-period-unit-lot', 'public-opening-date-lot',
  'deadline-receipt-request-date-lot', 'award-criterion-type-lot', 'award-criterion-name-lot', 'award-criterion-number-lot'] as const;

const Lang = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const Strs = z.array(z.string()).optional();
const TedDetail = TedNoticeSchema.extend({
  'description-proc': Lang.optional(), 'title-proc': Lang.optional(), 'buyer-city': Lang.optional(), 'award-criterion-name-lot': Lang.optional(),
  'estimated-value-proc': z.union([z.number(), z.string()]).optional(), 'estimated-value-cur-proc': z.union([z.string(), Strs]).optional(),
  'estimated-value-glo': z.union([z.number(), z.string()]).optional(), 'estimated-value-cur-glo': z.union([z.string(), Strs]).optional(),
  'buyer-post-code': Strs, 'buyer-email': Strs, 'organisation-tel-buyer': Strs, 'buyer-internet-address': Strs, 'submission-url-lot': Strs,
  'duration-period-value-lot': Strs, 'duration-period-unit-lot': Strs, 'public-opening-date-lot': Strs, 'deadline-receipt-request-date-lot': Strs,
  'award-criterion-type-lot': Strs, 'award-criterion-number-lot': Strs,
});

const arr = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** Text in the notice's official language, else English, else whatever exists. */
const inLang = (l: z.infer<typeof Lang> | undefined, lang3?: string): string[] => {
  if (!l) return [];
  const key = lang3?.toLowerCase();
  return arr((key && l[key]) ?? l.eng ?? l.mul ?? Object.values(l)[0]);
};
const money = (amount: unknown, currency: unknown): Money | undefined => {
  const n = Number(amount), cur = arr(currency as string | string[] | undefined)[0];
  return Number.isFinite(n) && n > 0 && cur && /^[A-Z]{3}$/.test(cur) ? { amount_minor: Math.round(n * 100), currency: cur } : undefined;
};
/** Earliest stated day ("2026-11-03+01:00" -> "2026-11-03"); TED gives no time for these, so none is invented. */
const firstDate = (dates: string[] | undefined) => (dates ?? []).map((d) => /^(\d{4}-\d{2}-\d{2})/.exec(d)?.[1]).filter((d): d is string => !!d).sort()[0];
const clip = (s: string | undefined, n = 4000) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, n) || undefined : undefined);
const httpUrl = (s: string | undefined) => (s && /^https?:\/\//i.test(s) ? s : undefined);
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;

export function mapTedDetail(raw: unknown): NoticeDetail {
  const n = TedDetail.parse(raw);
  const tender = mapTedNotice(n);
  const lang3 = n['official-language']?.[0];
  const ids = n['identifier-lot'] ?? [], titles = inLang(n['title-lot'], lang3), descs = inLang(n['description-lot'], lang3);
  const values = n['estimated-value-lot'] ?? [], curs = n['estimated-value-cur-lot'] ?? [];
  const durV = n['duration-period-value-lot'] ?? [], durU = n['duration-period-unit-lot'] ?? [];
  const count = Math.max(ids.length, titles.length, descs.length, values.length);
  const lots = Array.from({ length: count }, (_, i) => compact({
    id: ids[i] ?? String(i + 1), title: titles[i] ?? tender.lots[i]?.title ?? `Lot ${i + 1}`, description: clip(descs[i], 1500),
    value: money(values[i], curs[i] ?? curs[0]),
    duration: Number(durV[i]) > 0 && durU[i] ? { value: Number(durV[i]), unit: durU[i]!.toLowerCase() } : undefined,
  }));
  const types = n['award-criterion-type-lot'] ?? [], names = inLang(n['award-criterion-name-lot'], lang3), weights = n['award-criterion-number-lot'] ?? [];
  const criteria = new Map<string, NoticeDetail['award_criteria'][number]>();
  for (let i = 0; i < Math.max(types.length, names.length); i++) {
    const c = compact({ type: types[i], name: clip(names[i], 200), weight: weights[i] });
    if (Object.keys(c).length) criteria.set(JSON.stringify(c), c);
  }
  return {
    tender, lots, award_criteria: [...criteria.values()].slice(0, 12), exact_cpv_labels: {},
    ...compact({
      original_language: lang3 ? LANG3_TO_LANG2[lang3.toUpperCase()] : undefined,
      description: clip(inLang(n['description-proc'], lang3)[0] ?? descs[0]),
      estimated_value: money(n['estimated-value-glo'], n['estimated-value-cur-glo']) ?? money(n['estimated-value-proc'], n['estimated-value-cur-proc']),
      procedure: n['procedure-type'],
      documents_url: httpUrl(n['document-url-lot']?.[0]), submission_url: httpUrl(n['submission-url-lot']?.[0]),
    }),
    key_dates: compact({ published_at: tender.published_at ?? undefined, tender_deadline: tender.deadline ?? undefined,
      participation_deadline: firstDate(n['deadline-receipt-request-date-lot']), opening_at: firstDate(n['public-opening-date-lot']) }),
    buyer: compact({ name: tender.buyer, city: inLang(n['buyer-city'], lang3)[0], postal_code: n['buyer-post-code']?.[0],
      country_code: iso2(tender.country) || undefined, email: n['buyer-email']?.[0], phone: n['organisation-tel-buyer']?.[0],
      website: httpUrl(n['buyer-internet-address']?.[0]) }),
  };
}

/** TED v3 search with a publication-number query and the detail fields. */
export async function fetchTedDetail(id: string, fetchFn: FetchFn = fetch): Promise<NoticeDetail> {
  const res = await fetchFn(TED_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: `publication-number=${id}`, fields: TED_DETAIL_FIELDS, limit: 1, page: 1, paginationMode: 'PAGE_NUMBER' }),
  });
  if (!res.ok) throw new Error(`TED notice failed: HTTP ${res.status}`);
  const body = await res.json() as { notices?: unknown[] };
  const hit = (body.notices ?? []).find((x) => (x as Record<string, unknown>)?.['publication-number'] === id);
  if (!hit) throw new NoticeNotFound(id);
  return mapTedDetail(hit);
}

const FtsMoney = z.object({ amount: z.number(), currency: z.string() }).nullish();
const Party = z.object({
  name: z.string().optional(), roles: z.array(z.string()).default([]),
  address: z.object({ locality: z.string().optional(), postalCode: z.string().optional(), countryName: z.string().optional() }).passthrough().optional(),
  contactPoint: z.object({ name: z.string().optional(), email: z.string().optional(), telephone: z.string().optional(), url: z.string().optional() }).passthrough().optional(),
  details: z.object({ url: z.string().optional() }).passthrough().optional(),
}).passthrough();
const Criteria = z.object({ criteria: z.array(z.object({ type: z.string().optional(), name: z.string().optional(),
  numbers: z.array(z.object({ number: z.number().optional() }).passthrough()).optional() }).passthrough()).default([]) }).passthrough();
const FtsDetail = z.object({
  id: z.string(), date: z.string().optional(), parties: z.array(Party).default([]),
  tender: z.object({
    description: z.string().optional(), value: FtsMoney, procurementMethod: z.string().optional(), procurementMethodDetails: z.string().optional(),
    classification: z.object({ id: z.string(), description: z.string().optional() }).nullish(),
    additionalClassifications: z.array(z.object({ id: z.string(), description: z.string().optional() }).passthrough()).default([]),
    tenderPeriod: z.object({ endDate: z.string().optional() }).nullish(), enquiryPeriod: z.object({ endDate: z.string().optional() }).nullish(),
    documents: z.array(z.object({ url: z.string().optional() }).passthrough()).default([]),
    submissionMethodDetails: z.string().optional(),
    lots: z.array(z.object({ id: z.string(), title: z.string().optional(), description: z.string().optional(), value: FtsMoney,
      contractPeriod: z.object({ durationInDays: z.number().optional() }).passthrough().optional(), awardCriteria: Criteria.optional() }).passthrough()).default([]),
  }).passthrough(),
}).passthrough();
const iso = (d: string | undefined) => (d && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : undefined);

export function mapFtsDetail(raw: unknown): NoticeDetail {
  const tender = mapFtsRelease(raw);
  const r = FtsDetail.parse(raw), t = r.tender;
  const buyer = r.parties.find((p) => p.roles.includes('buyer'));
  const criteria = new Map<string, NoticeDetail['award_criteria'][number]>();
  for (const l of t.lots) for (const c of l.awardCriteria?.criteria ?? []) {
    const x = compact({ type: c.type, name: clip(c.name, 200), weight: c.numbers?.[0]?.number !== undefined ? String(c.numbers[0].number) : undefined });
    if (Object.keys(x).length) criteria.set(JSON.stringify(x), x);
  }
  const labels: Record<string, string> = {};
  for (const c of [t.classification, ...t.additionalClassifications]) if (c?.id && c.description) labels[c.id] = c.description;
  return {
    tender, exact_cpv_labels: labels, award_criteria: [...criteria.values()].slice(0, 12), original_language: 'en',
    lots: t.lots.map((l) => compact({ id: l.id, title: l.title ?? tender.lots.find((x) => x.lot_no === l.id)?.title ?? `Lot ${l.id}`,
      description: clip(l.description, 1500), value: l.value ? money(l.value.amount, l.value.currency) : undefined,
      duration: l.contractPeriod?.durationInDays ? { value: l.contractPeriod.durationInDays, unit: 'day' } : undefined })),
    ...compact({
      description: clip(t.description), estimated_value: t.value ? money(t.value.amount, t.value.currency) : undefined,
      procedure: t.procurementMethodDetails ?? t.procurementMethod,
      documents_url: httpUrl(t.documents.find((d) => httpUrl(d.url))?.url), submission_url: httpUrl(t.submissionMethodDetails),
    }),
    key_dates: compact({ published_at: iso(r.date), tender_deadline: iso(t.tenderPeriod?.endDate), enquiry_deadline: iso(t.enquiryPeriod?.endDate) }),
    buyer: compact({ name: tender.buyer, city: buyer?.address?.locality, postal_code: buyer?.address?.postalCode, country_code: 'GB',
      email: buyer?.contactPoint?.email, phone: buyer?.contactPoint?.telephone, contact_name: buyer?.contactPoint?.name,
      website: httpUrl(buyer?.details?.url) ?? httpUrl(buyer?.contactPoint?.url) }),
  };
}

/** Find a Tender OCDS release package for one notice id. */
export async function fetchFtsDetail(id: string, fetchFn: FetchFn = fetch): Promise<NoticeDetail> {
  const res = await fetchFn(`${FTS_ENDPOINT}/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) throw new NoticeNotFound(id);
  if (!res.ok) throw new Error(`Find a Tender notice failed: HTTP ${res.status}`);
  const body = await res.json() as { releases?: unknown[] };
  const hit = (body.releases ?? []).find((x) => (x as { id?: string })?.id === id);
  if (!hit) throw new NoticeNotFound(id);
  return mapFtsDetail(hit);
}

/** Contracts Finder and World Bank notices carry their detail in the pool row itself (`raw`); nothing else is fetched. */
export function poolDetail(t: PoolTender): NoticeDetail {
  const raw = (t.raw ?? {}) as Record<string, unknown>;
  const c = (raw.contact ?? {}) as Record<string, string | undefined>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const value = raw.value_original as { amount?: number; currency?: string } | null | undefined;
  const lang3 = str(raw.official_language);
  return {
    tender: t, lots: t.lots.map((l) => ({ id: l.lot_no, title: l.title })), award_criteria: [],
    exact_cpv_labels: (raw.cpv_labels ?? {}) as Record<string, string>,
    ...compact({
      original_language: lang3 ? LANG3_TO_LANG2[lang3.toUpperCase()] ?? lang3.slice(0, 2).toLowerCase() : undefined,
      description: str(raw.description), estimated_value: value ? money(value.amount, value.currency) : undefined, procedure: str(raw.procurement_method),
      documents_url: httpUrl(str(raw.documents_url)),
    }),
    key_dates: compact({ published_at: t.published_at ?? undefined, tender_deadline: t.deadline ?? undefined }),
    buyer: compact({ name: t.buyer, country_code: iso2(t.country) || undefined, city: str(c.city), postal_code: str(c.postal_code), email: str(c.email),
      phone: str(c.phone), contact_name: str(c.contact_name) }),
  };
}
