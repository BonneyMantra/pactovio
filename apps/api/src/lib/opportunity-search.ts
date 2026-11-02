import { fromRow, HttpError, type AiState, type Tender } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { tokens } from '@pactovio/quote';
import { cpvMatches, fetchNotices, lightningTriage, SEGMENT_CPV, type TriageWorkspace } from '@pactovio/sources';
import { aiFailure, aiPrecheck } from './ai-status';
import type { OnboardingState } from './onboarding-state';

const TED_BUYER_COUNTRIES = ['AUT','BEL','BGR','HRV','CYP','CZE','DNK','EST','FIN','FRA','DEU','GRC','HUN','IRL','ITA','LVA','LTU','LUX',
  'MLT','NLD','POL','PRT','ROU','SVK','SVN','ESP','SWE','NOR','ISL','LIE','CHE'];
export interface Notice {
  source: 'ted' | 'fts'; id: string; title: string; buyer: string; country: string; deadline: string | null; url: string | null; cpv: string[];
  fit: { method: 'ai' | 'keyword'; score?: number; reasons: string[] };
}
const GENERIC = new Set(['services', 'service', 'solutions', 'solution', 'products', 'product', 'systems', 'system', 'supply', 'support', 'general',
  'company', 'quality', 'customer', 'customers', 'industry', 'industries', 'other', 'various', 'management', 'provision']);
const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) });

/** Terms come only from what the customer confirmed: v1 capabilities and v2 offerings. */
export function fitTerms(state: OnboardingState): string[] {
  const phrases = [...(state.company.capabilities ?? []), ...(state.profile.offerings ?? [])];
  return [...new Set(phrases.flatMap((p) => tokens(p)).filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d/.test(t)))].slice(0, 60);
}

function keywordFit(t: Tender, terms: string[], segment: string): { matched: string[]; fit: Notice['fit'] } {
  const words = new Set(tokens([t.title, t.buyer, ...t.lots.map((l) => l.title), typeof t.raw?.description === 'string' ? t.raw.description : ''].join(' ')));
  const matched = terms.filter((x) => words.has(x));
  const reasons = [`CPV ${t.cpv.find((c) => cpvMatches([c], SEGMENT_CPV[segment as 'it'])) ?? t.cpv[0] ?? ''} is in your ${segment === 'it' ? 'IT' : 'industrial'} categories`];
  if (matched.length) reasons.unshift(`Mentions ${matched.slice(0, 6).join(', ')} from your profile`);
  return { matched, fit: { method: 'keyword', reasons } };
}

async function storedNotices(env: Env, now: Date): Promise<Tender[]> {
  const res = await env.DB.prepare(`SELECT * FROM tenders WHERE source IN ('ted','fts') AND (deadline IS NULL OR deadline > ?)
    ORDER BY published_at DESC LIMIT 300`).bind(now.toISOString()).all<Record<string, unknown>>();
  return res.results.map((r) => fromRow<Tender>(r));
}

/** On-demand version of the nightly scan's fetch + CPV filter; keyword fit always, Lightning triage of the top 10 when models work. */
export async function searchOpportunities(env: Env, workspace: string, state: OnboardingState) {
  const segment = state.company.supplier_segment;
  if (!segment) throw new HttpError(409, 'Choose your supplier segment before searching for opportunities.', 'company_incomplete');
  const now = new Date();
  const triageWs: TriageWorkspace = { id: workspace, name: state.company.name ?? 'Supplier', segment, profile: {
    legal_name: state.company.name ?? '', hq: { city: '', country: state.company.country ?? '' }, capabilities: state.company.capabilities ?? [],
    services: state.profile.offerings ?? [], regions: state.profile.markets ?? [] } };
  // Onboarding searches every TED buyer country (EU/EEA + candidates); the nightly scan keeps its narrower list.
  const live = await fetchNotices([triageWs], { now, sinceDays: 14, maxPerQuery: 50, countries: TED_BUYER_COUNTRIES, fetch: timed });
  const sourcesFailed = (['ted', 'fts'] as const).filter((s) => live.errors.some((e) => e.startsWith(s)));
  const pool = new Map<string, Tender>();
  for (const t of [...await storedNotices(env, now), ...live.tenders]) {
    if (t.source !== 'ted' && t.source !== 'fts') continue;
    if (t.deadline && new Date(t.deadline) <= now) continue;
    if (!cpvMatches(t.cpv, SEGMENT_CPV[segment])) continue;
    pool.set(`${t.source}|${t.source_ref}`, t);
  }
  if (!pool.size && sourcesFailed.length === 2) throw new HttpError(503, 'Public tender sources are not answering right now. Try again shortly.', 'sources_unavailable');
  const terms = fitTerms(state);
  const ranked = [...pool.values()].map((t) => ({ t, ...keywordFit(t, terms, segment) }))
    .sort((a, b) => b.matched.length - a.matched.length || (a.t.deadline ?? '9999').localeCompare(b.t.deadline ?? '9999')).slice(0, 25);
  let ai: AiState = (await aiPrecheck(env)) ?? { ran: true };
  if (ai.ran && ranked.length) {
    const triage = lightningTriage(env as never);
    const settled = await Promise.allSettled(ranked.slice(0, 10).map((r) => triage(triageWs, r.t)));
    let scored = 0;
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled') return;
      scored++;
      ranked[i]!.fit = { method: 'ai', score: Math.round(s.value.fit_score), reasons: [s.value.reason.slice(0, 400)] };
    });
    if (!scored) ai = aiFailure(settled.find((s) => s.status === 'rejected')?.reason);
  } else if (ai.ran) ai = { ran: false }; // nothing to score
  const scoredFirst = [...ranked].sort((a, b) => (b.fit.method === 'ai' ? (b.fit.score ?? 0) + 1000 : 0) - (a.fit.method === 'ai' ? (a.fit.score ?? 0) + 1000 : 0));
  const notices: Notice[] = scoredFirst.map(({ t, fit }) => ({ source: t.source as 'ted' | 'fts', id: t.source_ref, title: t.title, buyer: t.buyer,
    country: t.country, deadline: t.deadline, url: t.url,
    // Matching codes first so the CPV cited in the keyword reason is always in the returned list.
    cpv: [...new Set([...t.cpv.filter((c) => cpvMatches([c], SEGMENT_CPV[segment as 'it'])), ...t.cpv])].slice(0, 8), fit }));
  return { notices, ai, searched_at: now.toISOString(), sources_failed: sourcesFailed };
}
