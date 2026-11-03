import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>;
let a: Awaited<ReturnType<typeof customerFixture>>, b: typeof a, c: typeof a;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, method = 'GET', body?: unknown, cookie = a.cookie, headers: Record<string, string> = {}) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method, headers: { cookie, origin: 'https://pactovio.example', 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env, ctx);
const json = async (res: Response) => res.json() as Promise<any>;
const fixture = (n: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../packages/sources/test/fixtures', n), 'utf8'));
const company = { name: 'Meridian Instruments', country: 'MY', supplier_segment: 'industrial', capabilities: ['Laboratory automation', 'Pressure calibration'] };
const profile = { description: 'Laboratory automation and calibration instruments for research and hospital laboratories.', offerings: ['Pipetting robots', 'Pressure calibrators'],
  markets: ['Research institutes', 'Germany'], customers: ['Hospital laboratories', 'Police forensic labs'] };
const future = new Date(Date.now() + 20 * 86400000).toISOString();

const counts = { model: 0, ted: 0, fts: 0 };
function stub() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.pathname.endsWith('/chat/completions')) {
      counts.model++;
      const user = JSON.parse(String(init?.body)).messages.find((m: any) => m.role === 'user').content as string;
      const items = [...user.matchAll(/### ref (\d+)\nTitle: ([^\n]+)/g)].map(([, ref, title]) => ({ ref, title: `[${title}]`, summary: `Summary of ${title}.`,
        score: /PCR|NDP/.test(title!) ? 90 : 40, reasons: [`Reason for ${title}`, 'Second reason'], strengths: ['Laboratory automation'], risks: ['No German service team'] }));
      return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: 'm', usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ items }) } }] });
    }
    if (url.hostname === 'api.ted.europa.eu') {
      const query = String(JSON.parse(String(init?.body)).query);
      if (!query.startsWith('publication-number=')) return new Response('down', { status: 503 });
      counts.ted++;
      const id = query.split('=')[1];
      return id === '737366-2026' ? Response.json(fixture('ted-detail-737366-2026.json')) : Response.json({ notices: [], totalNoticeCount: 0 });
    }
    if (url.hostname === 'www.find-tender.service.gov.uk') {
      if (!url.pathname.endsWith('/104375-2026')) return new Response('down', { status: 503 });
      counts.fts++;
      return Response.json(fixture('fts-detail-104375-2026.json'));
    }
    return new Response('not found', { status: 404 });
  }));
}
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  a = await customerFixture(env); b = await customerFixture(env); c = await customerFixture(env);
  const ins = `INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, deadline, url, published_at, raw_json) VALUES (?, 'ted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await env.DB.batch([
    env.DB.prepare(ins).bind('tnd_v3_pcr', '737366-2026', 'POST-PCR-Pipettier-Roboter', 'Präsidium Technik, Logistik, Service der Polizei Baden-Württemberg', 'pptls', 'DEU',
      '["38000000"]', future, 'https://ted.europa.eu/en/notice/-/detail/737366-2026', new Date().toISOString(), JSON.stringify({ official_language: 'DEU', procedure_type: 'open' })),
    env.DB.prepare(ins).bind('tnd_v3_imp', '722700-2026', 'Dostawa aparatury naukowo – badawczej dla INTiBS PAN', 'INTiBS PAN', 'intibs', 'POL', '["38410000"]', future,
      'https://ted.europa.eu/en/notice/-/detail/722700-2026', new Date(Date.now() - 86400000).toISOString(), JSON.stringify({ official_language: 'POL' })),
  ]);
}, 60000);
afterAll(async () => dispose?.());
afterEach(() => vi.unstubAllGlobals());

describe('v3 mandatory company fields', () => {
  it('blocks profile confirmation and setup completion with the exact missing list, then confirms with a server timestamp', async () => {
    await call('/onboarding', 'PATCH', { company: { ...company, capabilities: ['Calibration'] } }, c.cookie);
    const blocked = await call('/onboarding', 'PATCH', { profile: { description: 'Calibration.', confirmed_at: 'now' } }, c.cookie);
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({ code: 'company_incomplete', missing: ['description', 'offerings', 'markets', 'customers'] });
    const state = await json(await call('/onboarding', 'GET', undefined, c.cookie));
    expect(state.profile.confirmed_at).toBeNull();
    expect(state.required_missing).toEqual(['description', 'offerings', 'markets', 'customers']);
    const done = await call('/onboarding/setup/complete', 'POST', {}, c.cookie);
    expect(done.status).toBe(409); expect((await json(done)).missing).toEqual(['description', 'offerings', 'markets', 'customers']);
    const ok = await json(await call('/onboarding', 'PATCH', { profile: { ...profile, confirmed_at: '1999-01-01T00:00:00Z' } }, c.cookie));
    expect(ok.required_missing).toEqual([]);
    expect(Date.now() - Date.parse(ok.profile.confirmed_at)).toBeLessThan(60000);
    expect((await call('/onboarding/setup/complete', 'POST', {}, c.cookie)).status).toBe(200);
  });
});

describe('v3 opportunities: translated AI assessment, cache, detail and save', () => {
  beforeAll(async () => { await call('/onboarding', 'PATCH', { company, profile }); });
  it('assesses every notice in one batched call, caches per notice + language + profile, and a repeat search costs nothing', async () => {
    stub();
    const first = await json(await call('/onboarding/opportunities/search', 'POST', {}, a.cookie, { 'accept-language': 'de-DE,de;q=0.9,en;q=0.5' }));
    expect(counts.model).toBe(1);
    expect(first).toMatchObject({ lang: 'de', ai: { ran: true, assessed: 2, cached: 0, unassessed: 0 } });
    expect(first.notices.map((n: any) => [n.id, n.fit.score])).toEqual([['737366-2026', 90], ['722700-2026', 40]]);
    expect(first.notices[0]).toMatchObject({ title: '[POST-PCR-Pipettier-Roboter]', original_title: 'POST-PCR-Pipettier-Roboter', original_language: 'de',
      country_code: 'DE', country_name: 'Deutschland', procedure: 'open', summary: 'Summary of POST-PCR-Pipettier-Roboter.', translated: true });
    expect(first.notices[1]).toMatchObject({ country_code: 'PL', country_name: 'Polen', original_language: 'pl' });
    const again = await json(await call('/onboarding/opportunities/search', 'POST', { lang: 'de' }));
    expect(counts.model).toBe(1);
    expect(again.ai).toMatchObject({ ran: true, assessed: 0, cached: 2, unassessed: 0 });
    expect(again.notices).toEqual(first.notices);
    await call('/onboarding/opportunities/search', 'POST', { lang: 'pl' });
    expect(counts.model).toBe(2); // another language is another assessment
    expect((await call('/onboarding/opportunities/search', 'POST', { lang: 'xx_bad' })).status).toBe(400);
  });
  it('opens the TED detail in-app, reusing the cached assessment and the cached source detail', async () => {
    stub();
    const before = counts.model;
    const res = await call('/onboarding/opportunities/ted/737366-2026?lang=de');
    expect(res.status).toBe(200);
    const d = await json(res);
    expect(counts.model).toBe(before);
    expect(d).toMatchObject({ source: 'ted', id: '737366-2026', title: '[POST-PCR-Pipettier-Roboter]', partial: false, url: 'https://ted.europa.eu/de/notice/-/detail/737366-2026',
      documents_url: 'https://ausschreibungen.landbw.de/Satellite/notice/CXR6YYDY45N/documents', key_dates: { opening_at: '2026-11-24' },
      buyer_contact: { email: 'polizei.bw.vergabestelle@polizei.bwl.de', city: 'Stuttgart' }, fit: { method: 'ai', score: 90, risks: ['No German service team'] },
      award_criteria: [{ type: 'price', name: 'Wertungspreis', weight: '40.0' }, { type: 'quality', name: 'Qualität', weight: '60.0' }] });
    expect(d.lots[0]).toMatchObject({ id: 'LOT-0001', duration: { value: 12, unit: 'month' } });
    expect(d.description).toMatch(/Pipettier-Roboterplattformen/);
    const teds = counts.ted;
    await call('/onboarding/opportunities/ted/737366-2026?lang=de');
    expect(counts.ted).toBe(teds);
    expect((await call('/onboarding/opportunities/ted/999999-2026')).status).toBe(404);
    expect((await call('/onboarding/opportunities/etenders/737366-2026')).status).toBe(400);
  });
  it('saves only AI-assessed notices into tenders + tender_matches, idempotently and per workspace', async () => {
    stub();
    const unassessed = await call('/onboarding/opportunities/save', 'POST', { source: 'ted', id: '722700-2026', lang: 'fr' });
    expect(unassessed.status).toBe(409); expect(await json(unassessed)).toMatchObject({ code: 'not_assessed' });
    await env.DB.prepare(`INSERT INTO tender_matches (workspace_id, tender_id, fit_score, fit_reason, status, created_at) VALUES (?, 'tnd_v3_pcr', 30, 'nightly', 'dismissed', ?)`)
      .bind(a.workspace, new Date().toISOString()).run();
    const saved = await json(await call('/onboarding/opportunities/save', 'POST', { source: 'ted', id: '737366-2026', lang: 'de' }));
    expect(saved).toMatchObject({ tender_id: 'tnd_v3_pcr', status: 'new', fit_score: 90, saved: [{ source: 'ted', id: '737366-2026', tender_id: 'tnd_v3_pcr' }] });
    await call('/onboarding/opportunities/save', 'POST', { source: 'ted', id: '737366-2026', lang: 'de' });
    const intakes = await env.DB.prepare("SELECT COUNT(*) AS n FROM intakes WHERE workspace_id = ? AND tender_id = 'tnd_v3_pcr' AND source = 'scan'").bind(a.workspace).first<{ n: number }>();
    expect(intakes?.n).toBe(1);
    const list = await json(await call('/tenders'));
    expect(list.items.map((x: any) => [x.tender.id, x.match.fit_score, x.match.status])).toContainEqual(['tnd_v3_pcr', 90, 'new']);
    expect((await json(await call('/tenders', 'GET', undefined, b.cookie))).items.map((x: any) => x.tender.id)).not.toContain('tnd_v3_pcr');
    expect((await json(await call('/onboarding'))).results.opportunities.saved).toHaveLength(1);
  });
  it('saves a live-only Find a Tender notice after its in-app detail assessed it', async () => {
    stub();
    const before = counts.model;
    const d = await json(await call('/onboarding/opportunities/fts/104375-2026?lang=en'));
    expect(counts.model).toBe(before + 1);
    expect(d).toMatchObject({ country_code: 'GB', value: { amount_minor: 500000000, currency: 'GBP' }, cpv: [{ code: '85141000', label: 'Services provided by medical personnel' }],
      buyer_contact: { contact_name: 'Bethan Davies' }, fit: { method: 'ai', score: 90 } });
    const saved = await json(await call('/onboarding/opportunities/save', 'POST', { source: 'fts', id: '104375-2026', lang: 'en' }));
    expect(saved.tender_id).toBe('tnd_fts_104375_2026');
    expect(await env.DB.prepare("SELECT source, title FROM tenders WHERE id = 'tnd_fts_104375_2026'").first()).toEqual({ source: 'fts', title: 'PME Opportunity for NDP Assessments' });
    expect((await json(await call('/onboarding'))).results.opportunities.saved.map((s: any) => s.id)).toEqual(['737366-2026', '104375-2026']);
  });
  it('reports the daily cap as unassessed with code budget and never a keyword label', async () => {
    stub();
    const previous = env;
    env = { ...env, MODEL_DAILY_CAP_USD: '0' } as Env;
    try {
      const out = await json(await call('/onboarding/opportunities/search', 'POST', { lang: 'it' }));
      expect(out.ai).toMatchObject({ ran: false, code: 'budget', unassessed: 2 });
      expect(out.notices.every((n: any) => n.fit.method === 'unassessed' && !n.translated)).toBe(true);
      expect(JSON.stringify(out)).not.toMatch(/keyword/i);
    } finally { env = previous; }
  });
});

describe('v2 rows', () => {
  it('reads a stored keyword-labelled summary as unassessed', async () => {
    await env.DB.prepare(`UPDATE company_onboarding SET data_json = json_patch(data_json, ?) WHERE workspace_id = ?`)
      .bind(JSON.stringify({ results: { opportunities: { count: 1, top: [{ id: '1-2026', fit: { method: 'keyword', reasons: ['Mentions pumps'] } }] } } }), b.workspace).run();
    const out = await json(await call('/onboarding', 'GET', undefined, b.cookie));
    expect(out.results.opportunities.top[0].fit).toEqual({ method: 'unassessed', reasons: [], strengths: [], risks: [] });
    expect(JSON.stringify(out)).not.toMatch(/keyword/i);
  });
});
