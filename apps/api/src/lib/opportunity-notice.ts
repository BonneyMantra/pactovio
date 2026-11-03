import type { NoticeAssessment, OpportunityFit } from '@pactovio/contracts';
import {
  COUNTRY_NAMES_EN, cpvLabels, cpvMatches, iso2, LANG3_TO_LANG2, regionOf, SEGMENT_CPV, TED_SITE_LANGS, type Domain, type Money, type NoticeSource, type PoolTender, type Region,
} from '@pactovio/sources';
import { noticeDomains } from './opportunity-pool';
type Tender = PoolTender;

/** The opportunity card shape shared by search, detail and the saved summary. No keyword labels ever leave the server. */
export interface OpportunityNotice {
  source: NoticeSource; id: string; title: string; original_title: string; original_language?: string; translated: boolean; summary: string;
  buyer: string; country_code: string; country_name: string; region: Region | null; domains: Domain[]; deadline: string | null; days_left: number | null; value?: Money; procedure?: string;
  cpv: { code: string; label: string }[]; url: string | null; fit: OpportunityFit;
}

const DAY = 86_400_000;
/** Accept-Language / ?lang= -> primary language subtag ("pl-PL" -> "pl"); English when absent or malformed. */
export function resolveLang(explicit: string | undefined, acceptLanguage: string | undefined): string {
  const tags = explicit ? [explicit] : (acceptLanguage ?? '').split(',').map((part) => {
    const [tag, ...params] = part.trim().split(';');
    const q = Number(params.find((x) => x.trim().startsWith('q='))?.trim().slice(2) ?? 1);
    return { tag: tag!.trim(), q: Number.isFinite(q) ? q : 0 };
  }).filter((x) => x.tag && x.tag !== '*' && x.q > 0).sort((a, b) => b.q - a.q).map((x) => x.tag);
  for (const tag of tags) {
    const primary = tag.split('-')[0]!.toLowerCase();
    if (/^[a-z]{2,3}$/.test(primary)) return primary;
  }
  return 'en';
}

export function countryName(code: string, lang: string): string {
  if (!code) return '';
  try {
    const name = new Intl.DisplayNames([lang, 'en'], { type: 'region' }).of(code);
    if (name && name !== code) return name;
  } catch { /* runtime without display names */ }
  return COUNTRY_NAMES_EN[code] ?? code;
}

export const daysLeft = (deadline: string | null, now: Date): number | null =>
  deadline && !Number.isNaN(Date.parse(deadline)) ? Math.ceil((Date.parse(deadline) - now.getTime()) / DAY) : null;

/** Stated value in its own currency (FTS keeps GBP; TED rows hold EUR only). */
export function noticeValue(t: Tender): Money | undefined {
  const original = t.raw?.value_original as { amount?: unknown; currency?: unknown } | null | undefined;
  if (original && typeof original.amount === 'number' && original.amount > 0 && typeof original.currency === 'string') {
    return { amount_minor: Math.round(original.amount * 100), currency: original.currency };
  }
  return t.value_eur && t.value_eur > 0 ? { amount_minor: t.value_eur * 100, currency: 'EUR' } : undefined;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
export function originalLanguage(t: Tender): string | undefined {
  if (t.source === 'fts' || t.source === 'cf') return 'en';
  const l3 = str(t.raw?.official_language);
  return l3 ? LANG3_TO_LANG2[l3.toUpperCase()] : undefined;
}

/** TED pages exist in every EU language; link the reader's language when TED has it. */
export function noticeUrl(t: Tender, lang: string): string | null {
  if (t.source === 'ted' && TED_SITE_LANGS.has(lang) && /^[0-9]+-[0-9]{4}$/.test(t.source_ref)) return `https://ted.europa.eu/${lang}/notice/-/detail/${t.source_ref}`;
  return t.url;
}

export function fitFrom(a: NoticeAssessment | null): OpportunityFit {
  return a ? { method: 'ai', score: Math.round(a.score), reasons: a.reasons, strengths: a.strengths, risks: a.risks }
    : { method: 'unassessed', reasons: [], strengths: [], risks: [] };
}

export function toNotice(t: Tender, a: NoticeAssessment | null, lang: string, now: Date, segment?: 'it' | 'industrial', exactLabels?: Record<string, string>): OpportunityNotice {
  const code = iso2(t.country), description = str(t.raw?.description);
  const labels = exactLabels ?? (t.raw?.cpv_labels && typeof t.raw.cpv_labels === 'object' ? t.raw.cpv_labels as Record<string, string> : {});
  const ordered = segment ? [...t.cpv.filter((c) => cpvMatches([c], SEGMENT_CPV[segment])), ...t.cpv] : t.cpv;
  const procedure = str(t.raw?.procedure_type) ?? str(t.raw?.procurement_method), value = noticeValue(t), original = originalLanguage(t);
  return {
    source: t.source as NoticeSource, id: t.source_ref, title: a?.title ?? t.title, original_title: t.title,
    ...(original ? { original_language: original } : {}), translated: !!a,
    summary: a?.summary ?? (description ? (description.length > 280 ? `${description.slice(0, 279).trimEnd()}…` : description) : ''),
    buyer: t.buyer, country_code: code, country_name: countryName(code, lang), region: code ? regionOf(code) : null, domains: noticeDomains(t), deadline: t.deadline, days_left: daysLeft(t.deadline, now),
    ...(value ? { value } : {}), ...(procedure ? { procedure } : {}),
    cpv: cpvLabels([...new Set(ordered)].slice(0, 8), labels), url: noticeUrl(t, lang), fit: fitFrom(a),
  };
}
