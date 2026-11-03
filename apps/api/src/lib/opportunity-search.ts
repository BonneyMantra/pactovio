import type { z } from 'zod';
import { HttpError, type OpportunitySearchInput } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { tokens } from '@pactovio/quote';
import {
  countryFromName, DOMAIN_LABELS, iso2, NOTICE_SOURCES, REGION_LABELS, regionOf, regionsInText, SEGMENT_DOMAINS, type Domain, type Region,
} from '@pactovio/sources';
import type { OnboardingState } from './onboarding-state';
import { assessNotices, profileHash, readScores } from './opportunity-assess';
import { countryName, noticeValue, toNotice } from './opportunity-notice';
import { loadPool, noticeDomains, viewKey, type ViewTender } from './opportunity-pool';

export type SearchInput = z.output<typeof OpportunitySearchInput>;
const GENERIC = new Set(['services', 'service', 'solutions', 'solution', 'products', 'product', 'systems', 'system', 'supply', 'support', 'general',
  'company', 'quality', 'customer', 'customers', 'industry', 'industries', 'other', 'various', 'management', 'provision']);

/** Terms come only from what the customer confirmed: capabilities and offerings. Internal ranking signal, never a label. */
export function fitTerms(state: OnboardingState): string[] {
  const phrases = [...(state.company.capabilities ?? []), ...(state.profile.offerings ?? [])];
  return [...new Set(phrases.flatMap((p) => tokens(p)).filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d/.test(t)))].slice(0, 60);
}
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const haystack = (t: ViewTender) => fold([t.title, t.buyer, ...t.lots.map((l) => l.title), typeof t.raw?.description === 'string' ? t.raw.description : ''].join(' '));

/** The user's own country and region first, then regions and countries named in their markets. */
function priorities(state: OnboardingState): { country: string; regions: Set<Region>; countries: Set<string> } {
  const country = state.company.country ?? '', markets = state.profile.markets ?? [];
  const regions = new Set<Region>(regionsInText(markets.join(' ')));
  const own = country ? regionOf(country) : null;
  if (own) regions.add(own);
  const countries = new Set(markets.map((m) => countryFromName(m)).filter(Boolean));
  for (const c of countries) { const r = regionOf(c); if (r) regions.add(r); }
  return { country, regions, countries };
}

type Row = { t: ViewTender; key: string; code: string; region: Region | null; domains: Domain[]; words: string; score?: number; heuristic: number };
const tier = (r: Row) => (r.score === undefined ? 1 : r.score >= 50 ? 0 : 2);
const byRelevance = (a: Row, b: Row) => tier(a) - tier(b) || (b.score ?? 0) - (a.score ?? 0) || b.heuristic - a.heuristic
  || (a.t.deadline ?? '9999').localeCompare(b.t.deadline ?? '9999');
const SORTS: Record<SearchInput['sort'], (a: Row, b: Row) => number> = {
  relevance: byRelevance,
  value: (a, b) => (b.t.value_eur ?? -1) - (a.t.value_eur ?? -1) || byRelevance(a, b),
  deadline: (a, b) => (a.t.deadline ?? '9999').localeCompare(b.t.deadline ?? '9999') || byRelevance(a, b),
  newest: (a, b) => (b.t.published_at ?? '').localeCompare(a.t.published_at ?? '') || byRelevance(a, b),
};

function counts<K extends string>(rows: Row[], keysOf: (r: Row) => K[]): Map<K, number> {
  const m = new Map<K, number>();
  for (const r of rows) for (const k of keysOf(r)) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** Worldwide pool -> filters -> sort -> one page; only that page (<= 20) is AI-assessed, each notice cached. */
export async function searchOpportunities(env: Env, _workspace: string, state: OnboardingState, input: SearchInput, lang: string) {
  const segment = state.company.supplier_segment;
  if (!segment) throw new HttpError(409, 'Choose your supplier segment before searching for opportunities.', 'company_incomplete', { missing: ['supplier_segment'] });
  const now = new Date();
  const domains = input.domains?.length ? input.domains : SEGMENT_DOMAINS[segment];
  const { pool, failed } = await loadPool(env, domains, now);
  const hash = await profileHash(state), scores = await readScores(env, lang, hash);
  const prio = priorities(state), terms = fitTerms(state);
  const rows: Row[] = pool.map((t) => {
    const code = iso2(t.country), region = code ? regionOf(code) : null, words = haystack(t);
    const place = code && (code === prio.country || prio.countries.has(code)) ? 3 : region && prio.regions.has(region) ? 2 : 0;
    const overlap = terms.filter((x) => words.includes(x)).length;
    return { t, key: viewKey(t), code, region, domains: noticeDomains(t), words, score: scores[viewKey(t)], heuristic: place * 10 + Math.min(overlap, 8) };
  });
  const q = fold(input.q ?? '').split(/\s+/).filter(Boolean);
  const currency = input.currency ?? 'EUR', horizon = input.deadline_within_days ? now.getTime() + input.deadline_within_days * 86_400_000 : null;
  const amount = (r: Row) => {
    const v = noticeValue(r.t as never);
    if (v?.currency === currency) return v.amount_minor / 100;
    return currency === 'EUR' && r.t.value_eur ? r.t.value_eur : null; // EUR also matches the sources' own EUR estimates
  };
  const base = (r: Row) => q.every((w) => r.words.includes(w))
    && (!horizon || (!!r.t.deadline && Date.parse(r.t.deadline) <= horizon))
    && (input.min_value === undefined || (amount(r) ?? -1) >= input.min_value)
    && (input.max_value === undefined || (amount(r) !== null && amount(r)! <= input.max_value));
  const inRegion = (r: Row) => !input.regions?.length || (!!r.region && input.regions.includes(r.region));
  const inCountry = (r: Row) => !input.countries?.length || input.countries.includes(r.code);
  const inDomain = (r: Row) => r.domains.some((d) => domains.includes(d));
  if (failed.length === NOTICE_SOURCES.length && !rows.some(inDomain)) {
    throw new HttpError(503, 'Public tender sources are not answering right now. Try again shortly.', 'sources_unavailable');
  }
  // Each facet counts with every filter except its own, so the UI can show what widening a filter would add.
  const pre = rows.filter(base);
  const facets = {
    regions: [...counts(pre.filter((r) => inCountry(r) && inDomain(r)), (r) => (r.region ? [r.region] : []))].sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: REGION_LABELS[id], count })),
    countries: [...counts(pre.filter((r) => inRegion(r) && inDomain(r)), (r) => (r.code ? [r.code] : []))].sort((a, b) => b[1] - a[1]).slice(0, 60)
      .map(([code, count]) => ({ code, name: countryName(code, lang), count })),
    domains: [...counts(pre.filter((r) => inRegion(r) && inCountry(r)), (r) => r.domains)].sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: DOMAIN_LABELS[id], count })),
  };
  const matched = pre.filter((r) => inRegion(r) && inCountry(r) && inDomain(r)).sort(SORTS[input.sort]);
  const page = matched.slice(input.offset, input.offset + input.limit);
  const { byKey, keys, ai } = await assessNotices(env, state, page.map((r) => r.t), lang);
  const assessed = new Map(page.map((r, i) => [r.key, byKey.get(keys[i]!) ?? null]));
  page.forEach((r) => { const a = assessed.get(r.key); if (a) r.score = a.score; });
  if (input.sort === 'relevance') page.sort(byRelevance); // fresh assessments reorder within the page only
  const notices = page.map((r) => toNotice(r.t, assessed.get(r.key) ?? null, lang, now, segment));
  return {
    notices, total: matched.length, offset: input.offset, limit: input.limit, sort: input.sort, domains, facets, lang, ai,
    searched_at: now.toISOString(), sources_failed: failed,
  };
}
