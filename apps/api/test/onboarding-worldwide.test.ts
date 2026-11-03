import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

// Recorded notices carry real dates, so the clock is pinned to the recording day (only Date is faked).
vi.useFakeTimers({ now: new Date('2026-11-04T08:00:00Z'), toFake: ['Date'] });
let env: Env, dispose: () => Promise<void>, a: Awaited<ReturnType<typeof customerFixture>>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, method = 'GET', body?: unknown) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method, headers: { cookie: a.cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env, ctx);
const search = async (body: Record<string, unknown> = {}, qs = '') => (await call(`/onboarding/opportunities/search${qs}`, 'POST', body)).json() as Promise<any>;
const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../packages/sources/test/fixtures', n), 'utf8'));
const ids = (out: any) => out.notices.map((n: any) => n.id);
const model = { calls: 0, items: 0 };
const ted = { notices: [...fx('ted-detail-737366-2026.json').notices, ...fx('ted-detail-722700-2026.json').notices], totalNoticeCount: 2 };

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  a = await customerFixture(env);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.pathname.endsWith('/chat/completions')) {
      const user = JSON.parse(String(init?.body)).messages.find((m: any) => m.role === 'user').content as string;
      const items = [...user.matchAll(/### ref (\d+)\nTitle: ([^\n]+)/g)].map(([, ref, title]) => ({ ref, title: `PL: ${title}`, summary: `Streszczenie: ${title}.`,
        score: /PCR|ICT/.test(title!) ? 88 : 35, reasons: ['Pasuje do automatyzacji laboratoriów', 'Kupujący publiczny'], strengths: ['Automatyka'], risks: ['Dostawa za granicę'] }));
      model.calls++; model.items += items.length;
      return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: 'm', usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ items }) } }] });
    }
    if (url.hostname === 'api.ted.europa.eu') {
      const query = String(JSON.parse(String(init?.body)).query);
      if (query.includes('buyer-country')) return new Response('onboarding must not restrict TED countries', { status: 400 });
      return Response.json(query.startsWith('publication-number=737366') ? { notices: [ted.notices[0]] } : ted);
    }
    if (url.hostname === 'www.contractsfinder.service.gov.uk') return Response.json(fx('cf-ocds.json'));
    if (url.hostname === 'search.worldbank.org') {
      const id = url.searchParams.get('id'), all = fx('worldbank-procnotices.json');
      return Response.json(id ? { ...all, procnotices: all.procnotices.filter((n: any) => n.id === id) } : all);
    }
    return new Response('down', { status: 503 }); // Find a Tender
  }));
  await call('/onboarding', 'PATCH', {
    company: { name: 'Wrocław Lab Systems', country: 'PL', supplier_segment: 'industrial', capabilities: ['Laboratory automation'] },
    profile: { description: 'Laboratory automation and pipetting robots for research institutes and hospitals.', offerings: ['Pipetting robots'],
      markets: ['Europe', 'Germany'], customers: ['Research institutes'] },
  });
}, 60000);
afterAll(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); await dispose?.(); });

describe('worldwide opportunity search', () => {
  it('pools every source worldwide, reports failures per source and assesses only the page', async () => {
    const out = await search({ lang: 'pl', domains: ['lab_medical', 'construction', 'it_software', 'professional_services'], limit: 3 });
    expect(out.sources_failed).toEqual(['fts']);
    // Open notices only: TED 722700, CF GPRS and World Bank OP00478103 had closed by 4 Nov.
    expect(out.total).toBe(7);
    expect(out.notices).toHaveLength(3);
    expect(model).toEqual({ calls: 1, items: 3 });
    expect(out.ai).toMatchObject({ ran: true, assessed: 3, cached: 0 });
    expect(out.notices[0]).toMatchObject({ id: '737366-2026', source: 'ted', region: 'europe', domains: ['lab_medical'], title: 'PL: POST-PCR-Pipettier-Roboter' });
    expect(out.facets.regions).toEqual(expect.arrayContaining([{ id: 'europe', label: 'Europe', count: 3 }, { id: 'africa', label: 'Africa', count: 3 }, { id: 'asia', label: 'Asia', count: 1 }]));
    expect(out.facets.countries).toEqual(expect.arrayContaining([{ code: 'ET', name: 'Etiopia', count: 2 }, { code: 'GB', name: 'Wielka Brytania', count: 2 }]));
    expect(out.facets.domains).toEqual(expect.arrayContaining([{ id: 'construction', label: 'Construction & engineering', count: 3 }]));
    expect(JSON.stringify(out)).not.toMatch(/keyword/i);
  });
  it('filters by country, region, domain, text, value and deadline, and paginates', async () => {
    expect(ids(await search({ domains: ['construction'], countries: ['et'] }))).toEqual(expect.arrayContaining(['OP00478723', 'OP00478765']));
    expect((await search({ domains: ['construction'], countries: ['ET'] })).total).toBe(2);
    expect((await search({}, '?domains=construction&regions=africa')).total).toBe(3);
    expect(ids(await search({ q: 'roboter' }))).toEqual(['737366-2026']);
    expect(ids(await search({ domains: ['professional_services'], min_value: 90000, currency: 'GBP' }))).toEqual(['35433066-264c-41c5-bb3c-836e971b0da5']);
    expect((await search({ domains: ['professional_services'], min_value: 200000, currency: 'GBP' })).total).toBe(0);
    expect(ids(await search({ domains: ['it_software'], deadline_within_days: 7 }))).toEqual(['3316a624-4ebb-4179-8d5e-019b5e900c61']);
    const byDeadline = await search({ domains: ['construction', 'lab_medical'], sort: 'deadline' });
    expect(ids(byDeadline)).toEqual(['OP00478765', 'OP00478790', '737366-2026', 'OP00478723']);
    const page2 = await search({ domains: ['construction', 'lab_medical'], sort: 'deadline', offset: 1, limit: 2 });
    expect(page2).toMatchObject({ total: 4, offset: 1, limit: 2 }); expect(ids(page2)).toEqual(['OP00478790', '737366-2026']);
    expect(ids(await search({ domains: ['construction', 'lab_medical'], sort: 'newest' })).at(-1)).toBe('737366-2026'); // TED published 26 Oct, World Bank 2 Nov
    for (const bad of [{ limit: 21 }, { sort: 'cheapest' }, { countries: ['POL'] }, { domains: ['gardening'] }]) {
      expect((await call('/onboarding/opportunities/search', 'POST', bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
  it('assesses more on request and reuses the cache', async () => {
    const before = { ...model };
    const out = await (await call('/onboarding/opportunities/assess', 'POST', { ids: ['wb:OP00478548', 'ted:737366-2026', 'cf:nope-0000'], lang: 'pl' })).json() as any;
    expect(model.items - before.items).toBe(1); // 737366 was assessed in Polish by the first search
    expect(out.notices.map((n: any) => [n.id, n.fit.method, n.fit.score])).toEqual([['OP00478548', 'ai', 88], ['737366-2026', 'ai', 88]]);
    expect(out.missing).toEqual(['cf:nope-0000']);
    expect((await call('/onboarding/opportunities/assess', 'POST', { ids: ['sam:1'] })).status).toBe(400);
  });
});

describe('worldwide detail and save', () => {
  it('writes the saved tender\'s stated key dates into workspace deadlines', async () => {
    const saved = await (await call('/onboarding/opportunities/save', 'POST', { source: 'ted', id: '737366-2026', lang: 'pl' })).json() as any;
    expect(saved.deadlines).toEqual([{ kind: 'submission', title: 'Tender submission deadline', due_at: '2026-11-24' },
      { kind: 'opening', title: 'Public opening of tenders', due_at: '2026-11-24' }]);
    await call('/onboarding/opportunities/save', 'POST', { source: 'ted', id: '737366-2026', lang: 'pl' });
    const list = await (await call('/onboarding/deadlines')).json() as any;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ tender_id: saved.tender_id, kind: 'submission', due_at: '2026-11-24', status: 'open',
      source_title: 'Präsidium Technik, Logistik, Service der Polizei Baden-Württemberg: POST-PCR-Pipettier-Roboter' });
    expect(list.items[0].excerpt).toBe('Tender submission deadline: 2026-11-24 09:00 UTC (TED 737366-2026).');
    expect((await (await call('/onboarding')).json() as any).results.deadlines).toMatchObject({ count: 2 });
  });
  it('reads Contracts Finder and World Bank notices in-app and saves a World Bank notice into tenders', async () => {
    const cf = await (await call('/onboarding/opportunities/cf/35433066-264c-41c5-bb3c-836e971b0da5?lang=en')).json() as any;
    expect(cf).toMatchObject({ source: 'cf', country_code: 'GB', saveable: true, value: { amount_minor: 10000000, currency: 'GBP' },
      buyer_contact: { contact_name: 'Julie Weaver' }, cpv: [{ code: '79300000', label: 'Market and economic research; polling and statistics' }] });
    const wb = await (await call('/onboarding/opportunities/wb/OP00478548?lang=pl')).json() as any;
    expect(wb).toMatchObject({ source: 'wb', country_code: 'BD', region: 'asia', fit: { method: 'ai', score: 88 }, saveable: true });
    expect(wb.description).toBeTruthy();
    const saved = await call('/onboarding/opportunities/save', 'POST', { source: 'wb', id: 'OP00478548', lang: 'pl' });
    expect(saved.status).toBe(200); const body = await saved.json() as any;
    expect(body.tender_id).toBeTruthy(); expect(body.fit_score).toBe(88);
    const row = await env.DB.prepare('SELECT source, source_ref FROM tenders WHERE id = ?').bind(body.tender_id).first();
    expect(row).toMatchObject({ source: 'wb', source_ref: 'OP00478548' });
  });
});
