import type { Hono, Context } from 'hono';
import { z } from 'zod';
import {
  DeadlineExtractInput, DeadlinesSaveInput, HttpError, OpportunityAssessInput, OpportunityDetailParams, OpportunityDetailQuery, OpportunitySaveInput, OpportunitySearchInput,
  QuoteCreateInput, QuoteDraftInput, WebsiteAnalyzeInput,
} from '@pactovio/contracts';
import { takeLimit } from '../lib/customer-security';
import { extractDeadlines } from '../lib/deadline-extract';
import { listDeadlines, refineTitles, saveDeadlines } from '../lib/deadline-store';
import { createOnboardingQuote, quoteCandidates } from '../lib/onboarding-quote';
import { patchData, readOnboarding, saveResult } from '../lib/onboarding-state';
import { assessByIds, opportunityDetail, saveOpportunity } from '../lib/opportunity-detail';
import { resolveLang } from '../lib/opportunity-notice';
import { searchOpportunities } from '../lib/opportunity-search';
import { analyzeWebsite } from '../lib/site-analyze';
import type { AppEnv } from '../lib/types';

/** JSON body or a 400; bodies are capped before parsing so pasted documents cannot exhaust the isolate. */
async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T, maxBytes = 200_000): Promise<z.output<T>> {
  if (Number(c.req.header('content-length') ?? 0) > maxBytes) throw new HttpError(413, 'The request is too large.', 'body_too_large');
  const text = await c.req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'The request is too large.', 'body_too_large');
  let raw: unknown;
  try { raw = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Send a JSON request body.', 'validation'); }
  return schema.parse(raw);
}

const LISTS = new Set(['regions', 'countries', 'domains']), NUMBERS = new Set(['min_value', 'max_value', 'deadline_within_days', 'offset', 'limit']);
/** Query-string form of the search filters; values are still validated by OpportunitySearchInput. */
function searchQuery(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const name = key.replace(/\[\]$/, ''), values = params.getAll(key);
    if (LISTS.has(name)) out[name] = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    else out[name] = NUMBERS.has(name) && values[0] !== '' && Number.isFinite(Number(values[0])) ? Number(values[0]) : values[0];
  }
  return out;
}

export function registerOnboardingTools(app: Hono<AppEnv>): void {
  app.post('/website/analyze', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, WebsiteAnalyzeInput, 8_000);
    await takeLimit(c.env.DB, `onboarding-site:${ws}`, 10, 3600);
    const result = await analyzeWebsite(c.env, input.url);
    await patchData(c.env.DB, ws, { website_analysis: { url: result.sources[0]?.url ?? input.url, ...result } });
    return c.json(result);
  });

  app.post('/opportunities/search', async (c) => {
    const ws = c.get('auth').workspaceId;
    // Filters may come as query parameters (?countries=PL&countries=DE or countries=PL,DE) and/or in the JSON body (body wins).
    const raw = await body(c, z.record(z.string(), z.unknown()), 4_000);
    const input = OpportunitySearchInput.parse({ ...searchQuery(new URL(c.req.url).searchParams), ...raw });
    await takeLimit(c.env.DB, `onboarding-opps:${ws}`, 120, 3600);
    const lang = resolveLang(input.lang, c.req.header('accept-language'));
    const out = await searchOpportunities(c.env, ws, await readOnboarding(c.env.DB, ws), input, lang);
    if (input.offset === 0) {
      await saveResult(c.env.DB, ws, 'opportunities', {
        count: out.total, lang, ai_ran: out.ai.ran, ai_scored: out.notices.filter((n) => n.fit.method === 'ai').length,
        top: out.notices.slice(0, 10), sources_failed: out.sources_failed,
      });
    }
    return c.json(out);
  });
  app.post('/opportunities/assess', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, OpportunityAssessInput, 4_000);
    await takeLimit(c.env.DB, `onboarding-opps-assess:${ws}`, 30, 3600);
    const lang = resolveLang(input.lang, c.req.header('accept-language'));
    return c.json(await assessByIds(c.env, await readOnboarding(c.env.DB, ws), input.ids, lang));
  });
  app.post('/opportunities/save', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, OpportunitySaveInput, 1_000);
    await takeLimit(c.env.DB, `onboarding-opps-save:${ws}`, 60, 3600);
    const lang = resolveLang(input.lang, c.req.header('accept-language'));
    return c.json(await saveOpportunity(c.env, ws, await readOnboarding(c.env.DB, ws), input.source, input.id, lang));
  });
  app.get('/opportunities/:source/:id', async (c) => {
    const ws = c.get('auth').workspaceId;
    const params = OpportunityDetailParams.parse(c.req.param()), query = OpportunityDetailQuery.parse(c.req.query());
    await takeLimit(c.env.DB, `onboarding-opps-detail:${ws}`, 120, 3600);
    const lang = resolveLang(query.lang, c.req.header('accept-language'));
    return c.json(await opportunityDetail(c.env, await readOnboarding(c.env.DB, ws), params.source, params.id, lang));
  });

  app.post('/deadlines/extract', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, DeadlineExtractInput, 200_000);
    await takeLimit(c.env.DB, `onboarding-dates:${ws}`, 60, 3600);
    const found = extractDeadlines(input.text);
    const { items, ai } = await refineTitles(c.env, found);
    return c.json({ items, ai });
  });
  app.post('/deadlines', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, DeadlinesSaveInput, 100_000);
    const items = await saveDeadlines(c.env.DB, ws, input);
    await saveResult(c.env.DB, ws, 'deadlines', { count: items.length });
    return c.json({ items });
  });
  app.get('/deadlines', async (c) => c.json({ items: await listDeadlines(c.env.DB, c.get('auth').workspaceId) }));

  app.post('/quote-draft', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, QuoteDraftInput, 100_000);
    return c.json(await quoteCandidates(c.env.DB, ws, `${input.title} ${input.request_text}`));
  });
  app.post('/quote', async (c) => {
    const ws = c.get('auth').workspaceId, input = await body(c, QuoteCreateInput, 100_000);
    await takeLimit(c.env.DB, `onboarding-quote:${ws}`, 30, 3600);
    const out = await createOnboardingQuote(c.env, ws, input);
    await saveResult(c.env.DB, ws, 'quotes', { quote_id: out.quote_id });
    return c.json(out);
  });
}
