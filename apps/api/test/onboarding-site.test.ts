import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>, a: Awaited<ReturnType<typeof customerFixture>>;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, body: unknown = {}, cookie = a.cookie) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method: 'POST', headers: { cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env, ctx);
const json = async (res: Response) => res.json() as Promise<any>;
const SITE = 'https://www.meridian-instruments.com';
const pages: Record<string, string> = {
  [`${SITE}/`]: `<html><head><title>Meridian Instruments | Calibration equipment</title><meta name="description" content="Pressure and temperature calibration equipment for process plants in Malaysia.">
    </head><body><a href="/products">Products</a><a href="/products/pressure-calibrators">Pressure calibrators</a><a href="/industries/water">Water utilities</a>
    <h1>Industrial calibration instruments</h1><p>We manufacture calibration instruments and sensors for industrial automation and equipment makers.</p></body></html>`,
  [`${SITE}/products`]: `<html><head><title>Products</title></head><body><a href="/products/temperature-calibrators">Temperature calibrators</a><h2>Instruments</h2></body></html>`,
};
type Model = 'off' | 'reject' | ((body: any) => unknown);
function stub(model: Model, extra: (url: URL) => Response | null = () => null) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    seen.push(url.href);
    if (url.hostname === 'cloudflare-dns.com') {
      const host = url.searchParams.get('name')!, a = url.searchParams.get('type') === 'A';
      const ip = host.endsWith('meridian-instruments.com') ? '93.184.216.34' : host === 'inside.meridian-labs.com' ? '10.0.0.7' : null;
      return Response.json({ Status: 0, Answer: ip && a ? [{ type: 1, data: ip }] : [] });
    }
    if (url.hostname.includes('tokenfactory') || url.pathname.endsWith('/chat/completions')) {
      if (model === 'reject' || model === 'off') return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
      const content = JSON.stringify(model(JSON.parse(String(init?.body))));
      return Response.json({ id: 'cmpl', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    }
    const other = extra(url);
    if (other) return other;
    const html = pages[url.href];
    return html ? new Response(html, { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 });
  }));
  return seen;
}
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  a = await customerFixture(env);
}, 60000);
afterAll(async () => dispose?.());
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/onboarding/website/analyze', () => {
  it('reads same-site pages deterministically, labels the 401 and persists the analysis', async () => {
    stub('reject');
    const res = await call('/onboarding/website/analyze', { url: 'www.meridian-instruments.com' });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.ai).toEqual({ ran: false, code: 'auth_rejected' });
    expect(out.pages_read).toBe(2);
    expect(out.sources.map((s: any) => s.url)).toEqual([`${SITE}/`, `${SITE}/products`]);
    expect(out.draft).toMatchObject({ name: 'Meridian Instruments', supplier_segment: 'industrial', customers: [],
      offerings: ['Pressure calibrators', 'Temperature calibrators'], markets: ['Water utilities'] });
    expect(out.draft.description).toContain('Pressure and temperature calibration');
    const saved = await json(await app.fetch(new Request('https://pactovio.example/api/onboarding', { headers: { cookie: a.cookie } }), env, ctx));
    expect(saved.website_analysis).toMatchObject({ url: `${SITE}/`, pages_read: 2, ai: { ran: false, code: 'auth_rejected' } });
  });
  it('adds only cited model items when models work', async () => {
    stub(() => ({ name: 'Meridian Instruments', description: { text: 'Calibration equipment maker serving process plants.', source_url: `${SITE}/` },
      offerings: [{ text: 'Calibration services', source_url: `${SITE}/products` }], customers: [{ text: 'Invented Bank', source_url: 'https://news.example/' }],
      markets: [], capabilities: [{ text: 'Pressure calibration', source_url: `${SITE}/` }], country: { code: 'MY', source_url: `${SITE}/` }, supplier_segment: null }));
    const out = await json(await call('/onboarding/website/analyze', { url: `${SITE}/` }));
    expect(out.ai).toEqual({ ran: true });
    expect(out.draft.offerings[0]).toBe('Calibration services');
    expect(out.draft.customers).toEqual([]);
    expect(out.draft).toMatchObject({ country: 'MY', description: 'Calibration equipment maker serving process plants.' });
  });
  it('maps blocked, unreadable and rate-limited cases to the contract codes', async () => {
    const seen = stub('off', (url) => url.hostname === 'redirector.meridian-instruments.com'
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) : null);
    for (const url of ['http://127.0.0.1/', 'localhost', 'file:///etc/passwd', 'https://inside.meridian-labs.com/', 'https://www.meridian-instruments.com:8080/']) {
      const res = await call('/onboarding/website/analyze', { url });
      expect(res.status, url).toBe(400); expect((await json(res)).code, url).toBe('invalid_url');
    }
    const redirected = await call('/onboarding/website/analyze', { url: 'https://redirector.meridian-instruments.com/' });
    expect(redirected.status).toBe(422); expect(await json(redirected)).toMatchObject({ code: 'site_unreadable' });
    expect(seen.some((u) => u.includes('169.254') || u.includes('127.0.0.1') || u.startsWith('file:'))).toBe(false);
    let last = 0;
    for (let i = 0; i < 10 && last !== 429; i++) last = (await call('/onboarding/website/analyze', { url: 'https://missing.meridian-instruments.com/' })).status;
    expect(last).toBe(429);
  });
});

describe('POST /api/onboarding/opportunities/search', () => {
  const future = new Date(Date.now() + 20 * 86400000).toISOString();
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, deadline, url, published_at)
        VALUES ('tnd_onb_cal', 'ted', '712345-2026', 'Supply of pressure calibration instruments for water laboratories', 'Uisce Eireann', 'uisce_eireann', 'IE', '["38410000"]', ?, 'https://ted.europa.eu/en/notice/-/detail/712345-2026', ?)`).bind(future, new Date().toISOString()),
      env.DB.prepare(`INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, deadline, url, published_at)
        VALUES ('tnd_onb_furn', 'ted', '712399-2026', 'Office furniture framework', 'Malta Enterprise', 'malta_enterprise', 'MT', '["39130000"]', ?, null, ?)`).bind(future, new Date().toISOString()),
      env.DB.prepare(`INSERT INTO tenders (id, source, source_ref, title, buyer, buyer_key, country, cpv_json, deadline, url, published_at)
        VALUES ('tnd_onb_closed', 'fts', 'ocds-closed', 'Closed calibration contract', 'NHS Supply Chain', 'nhs', 'GB', '["38410000"]', '2020-01-01T00:00:00Z', null, null)`),
    ]);
  });
  const sourcesDown = (url: URL) => /ted\.europa\.eu|find-tender|contractsfinder|worldbank/.test(url.hostname) ? new Response('down', { status: 503 }) : null;
  it('requires a segment and returns unassessed notices without keyword labels when models are off', async () => {
    env = { ...env, MODELS_DISABLED: '1' } as Env;
    stub('off', sourcesDown);
    const blocked = await call('/onboarding/opportunities/search');
    expect(blocked.status).toBe(409); expect(await json(blocked)).toMatchObject({ code: 'company_incomplete', missing: ['supplier_segment'] });
    await app.fetch(new Request('https://pactovio.example/api/onboarding', { method: 'PATCH', headers: { cookie: a.cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' },
      body: JSON.stringify({ company: { name: 'Meridian Instruments', country: 'MY', supplier_segment: 'industrial', capabilities: ['Pressure calibration'] }, profile: { offerings: ['Calibration instruments'] } }) }), env, ctx);
    const out = await json(await call('/onboarding/opportunities/search'));
    expect(out.ai).toMatchObject({ ran: false, code: 'models_disabled', assessed: 0, cached: 0, unassessed: 1 });
    expect(out.sources_failed).toEqual(['ted', 'fts', 'cf', 'wb']);
    expect(out).toMatchObject({ total: 1, offset: 0, limit: 20, sort: 'relevance' });
    expect(out.lang).toBe('en');
    expect(out.notices.map((n: any) => n.id)).toEqual(['712345-2026']);
    expect(out.notices[0]).toMatchObject({ source: 'ted', buyer: 'Uisce Eireann', country_code: 'IE', country_name: 'Ireland', translated: false,
      title: 'Supply of pressure calibration instruments for water laboratories', original_title: 'Supply of pressure calibration instruments for water laboratories',
      cpv: [{ code: '38410000', label: 'Laboratory, optical and precision equipments (excl. glasses)' }],
      fit: { method: 'unassessed', reasons: [], strengths: [], risks: [] } });
    expect(out.notices[0].days_left).toBeGreaterThanOrEqual(19);
    expect(out.notices[0].fit.score).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/keyword/i);
    const saved = await json(await app.fetch(new Request('https://pactovio.example/api/onboarding', { headers: { cookie: a.cookie } }), env, ctx));
    expect(saved.results.opportunities).toMatchObject({ count: 1, ai_ran: false, lang: 'en', top: [{ id: '712345-2026' }] });
  });
  it('translates and scores with one batched model call when models answer', async () => {
    env = { ...env, MODELS_DISABLED: undefined } as Env;
    stub(() => ({ items: [{ ref: '1', title: 'Dostawa przyrządów do kalibracji ciśnienia', summary: 'Uisce Eireann kupuje przyrządy kalibracyjne do laboratoriów.',
      score: 82, reasons: ['Zakres pasuje do kalibracji ciśnienia.', 'Kupujący to przedsiębiorstwo wodne.'], strengths: ['Kalibracja ciśnienia'], risks: ['Brak lokalnego serwisu w Irlandii'] }] }), sourcesDown);
    const out = await json(await call('/onboarding/opportunities/search', { lang: 'pl-PL' }));
    expect(out.ai).toMatchObject({ ran: true, assessed: 1, cached: 0, unassessed: 0 });
    expect(out.lang).toBe('pl');
    expect(out.notices[0]).toMatchObject({ title: 'Dostawa przyrządów do kalibracji ciśnienia', translated: true, country_name: 'Irlandia',
      url: 'https://ted.europa.eu/pl/notice/-/detail/712345-2026' });
    expect(out.notices[0].fit).toEqual({ method: 'ai', score: 82, reasons: ['Zakres pasuje do kalibracji ciśnienia.', 'Kupujący to przedsiębiorstwo wodne.'],
      strengths: ['Kalibracja ciśnienia'], risks: ['Brak lokalnego serwisu w Irlandii'] });
  });
  it('reports sources_unavailable instead of an empty success when nothing could be read', async () => {
    await env.DB.prepare("UPDATE tenders SET deadline = '2020-01-01T00:00:00Z' WHERE id = 'tnd_onb_cal'").run();
    env = { ...env, MODELS_DISABLED: '1' } as Env;
    stub('off', sourcesDown);
    const res = await call('/onboarding/opportunities/search');
    expect(res.status).toBe(503); expect(await json(res)).toMatchObject({ code: 'sources_unavailable' });
  });
});
