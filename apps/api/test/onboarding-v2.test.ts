import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>;
let a: Awaited<ReturnType<typeof customerFixture>>, b: typeof a;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (path: string, method = 'GET', body?: unknown, cookie = a.cookie) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  method, headers: { cookie, origin: 'https://pactovio.example', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env, ctx);
const json = async (res: Response) => res.json() as Promise<any>;
const company = { name: 'Meridian Instruments', country: 'my', supplier_segment: 'industrial', capabilities: ['Pressure calibration', 'Laser level supply'] };
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  env = { ...env, MODELS_DISABLED: '1' } as Env;
  a = await customerFixture(env); b = await customerFixture(env);
}, 60000);
afterAll(async () => dispose?.());
afterEach(() => vi.unstubAllGlobals());

describe('onboarding v2 state', () => {
  it('returns v1 fields plus v2 defaults and persists strict partial patches', async () => {
    const empty = await json(await call('/onboarding'));
    expect(empty).toMatchObject({ company: {}, completed_at: null, person: {}, profile: { confirmed_at: null }, goals: [],
      setup: { version: 2, stage: 'about', completed_at: null }, results: {}, website_analysis: null });
    const res = await call('/onboarding', 'PATCH', { person: { full_name: 'Aisyah Rahman', job_title: 'Sales engineer' }, goals: ['quotes', 'deadlines', 'quotes'],
      setup: { stage: 'company' }, profile: { offerings: ['Pressure calibrators'], confirmed_at: '1999-01-01T00:00:00Z' } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.person).toEqual({ full_name: 'Aisyah Rahman', job_title: 'Sales engineer' });
    expect(body.goals).toEqual(['quotes', 'deadlines']);
    expect(body.setup).toEqual({ version: 2, stage: 'company', completed_at: null });
    expect(body.profile.offerings).toEqual(['Pressure calibrators']);
    expect(body.profile.confirmed_at).not.toBe('1999-01-01T00:00:00Z');
    expect(Date.now() - Date.parse(body.profile.confirmed_at)).toBeLessThan(60000);
    const merged = await json(await call('/onboarding', 'PATCH', { person: { job_title: 'Head of sales' } }));
    expect(merged.person).toEqual({ full_name: 'Aisyah Rahman', job_title: 'Head of sales' });
    for (const bad of [{ setup: { completed_at: '2026-11-02T00:00:00Z' } }, { goals: ['growth'] }, { person: { role: 'owner' } }, { results: { quotes: { quote_id: 'quo_x' } } }]) {
      expect((await call('/onboarding', 'PATCH', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await json(await call('/onboarding', 'GET', undefined, b.cookie))).person).toEqual({});
  });
  it('requires a valid company for v2 completion, then completes v1 too', async () => {
    const blocked = await call('/onboarding/setup/complete', 'POST', {});
    expect(blocked.status).toBe(409); expect(await json(blocked)).toMatchObject({ code: 'company_incomplete' });
    await call('/onboarding', 'PATCH', { company });
    const done = await json(await call('/onboarding/setup/complete', 'POST', {}));
    expect(done.completed_at).toBeTruthy(); expect(done.setup.completed_at).toBeTruthy(); expect(done.setup.stage).toBe('ready');
    const again = await json(await call('/onboarding/setup/complete', 'POST', {}));
    expect(again.setup.completed_at).toBe(done.setup.completed_at); expect(again.completed_at).toBe(done.completed_at);
    expect(await json(await call('/session'))).toMatchObject({ onboarding_complete: true, setup_complete: true });
  });
  it('never resets a completed v1 profile and shows returning users setup as unfinished', async () => {
    await call('/onboarding', 'PATCH', { company }, b.cookie);
    const v1 = await json(await call('/onboarding/complete', 'POST', {}, b.cookie));
    expect(v1.completed_at).toBeTruthy(); expect(v1.setup.completed_at).toBeNull();
    expect((await call('/onboarding', 'PATCH', { company: { capabilities: [] } }, b.cookie)).status).toBe(400);
    const resumed = await json(await call('/onboarding', 'PATCH', { setup: { stage: 'goals' }, goals: ['opportunities'] }, b.cookie));
    expect(resumed).toMatchObject({ completed_at: v1.completed_at, setup: { stage: 'goals', completed_at: null }, company: { name: 'Meridian Instruments', country: 'MY' } });
  });
});

describe('onboarding deadlines', () => {
  const text = 'Clarification questions close on 12 March 2027. Tenders must be submitted by 2027-04-02 at noon.';
  it('extracts with an honest AI state, saves idempotently, lists per workspace and feeds the calendar', async () => {
    const extracted = await json(await call('/onboarding/deadlines/extract', 'POST', { text, title: 'RFQ-118 laboratory calibration' }));
    expect(extracted.ai).toEqual({ ran: false, code: 'models_disabled' });
    expect(extracted.items.map((i: any) => i.due_at)).toEqual(['2027-03-12', '2027-04-02']);
    const items = extracted.items.map(({ title, due_at, excerpt }: any) => ({ title, due_at, excerpt }));
    const saved = await call('/onboarding/deadlines', 'POST', { items, source_title: 'RFQ-118 laboratory calibration' });
    expect(saved.status).toBe(200);
    await call('/onboarding/deadlines', 'POST', { items, source_title: 'RFQ-118 laboratory calibration' });
    const list = await json(await call('/onboarding/deadlines'));
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ due_at: '2027-03-12', status: 'open', source_title: 'RFQ-118 laboratory calibration' });
    expect((await json(await call('/onboarding/deadlines', 'GET', undefined, b.cookie))).items).toEqual([]);
    expect((await json(await call('/onboarding'))).results.deadlines).toMatchObject({ count: 2 });
    const ics = await json(await call('/ics'));
    const feed = await (await app.fetch(new Request(new URL(ics.url).href.replace(/^https:\/\/[^/]+/, 'https://pactovio.example')), env, ctx)).text();
    expect(feed).toContain('DTSTART;VALUE=DATE:20270312');
    for (const bad of [{ items: [{ title: 'x', due_at: '2027-02-30', excerpt: '' }] }, { items: [] }, { items: [{ title: '', due_at: '2027-02-01' }] }]) {
      expect((await call('/onboarding/deadlines', 'POST', bad)).status).toBe(400);
    }
    expect((await call('/onboarding/deadlines/extract', 'POST', { text: 'x'.repeat(40001) })).status).toBe(400);
  });
  it('labels an upstream 401 as auth_rejected and still returns the deterministic dates', async () => {
    const live = { ...env, MODELS_DISABLED: undefined } as Env, previous = env;
    env = live;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Unauthorized', code: 'unauthorized' } }, { status: 401 })));
    try {
      const out = await json(await call('/onboarding/deadlines/extract', 'POST', { text }));
      expect(out.ai).toEqual({ ran: false, code: 'auth_rejected' });
      expect(out.items).toHaveLength(2);
    } finally { env = previous; }
  });
});

describe('onboarding quotes', () => {
  it('needs a catalogue, ranks by selling data only and saves a priced quote', async () => {
    const none = await call('/onboarding/quote-draft', 'POST', { request_text: 'Need 4 pressure calibrators' }, b.cookie);
    expect(none.status).toBe(409); expect(await json(none)).toMatchObject({ code: 'catalogue_required' });
    const product = { name: 'Pressure calibrator PC-40', sku: 'PC-40', family: 'Calibration', unit: 'piece', description: 'Handheld pressure calibrator, 0-40 bar',
      unit_price_minor: 185000, currency: 'MYR', internal_unit_cost_minor: 99900, cost_currency: 'MYR', cost_unit: 'piece' };
    const created = await json(await call('/products', 'POST', product, b.cookie));
    await call('/products', 'POST', { ...product, name: 'Laser level LL-2', sku: 'LL-2', family: 'Survey', description: 'Rotary laser level' }, b.cookie);
    const draft = await json(await call('/onboarding/quote-draft', 'POST', { request_text: 'Please quote 4 pressure calibrators (0-40 bar) for our Penang lab', title: 'Lab RFQ' }, b.cookie));
    expect(draft.method).toBe('keyword');
    expect(draft.candidates[0]).toMatchObject({ product_id: created.id, name: 'Pressure calibrator PC-40', sku: 'PC-40', unit_price_minor: 185000, currency: 'MYR', unit: 'piece' });
    expect(draft.candidates[0].matched_terms).toEqual(expect.arrayContaining(['pressure', 'bar']));
    expect(JSON.stringify(draft)).not.toMatch(/99900|internal_unit_cost|cost_/);
    const res = await call('/onboarding/quote', 'POST', { request_text: 'Please quote 4 pressure calibrators', title: 'Lab RFQ', customer: 'Air Selangor',
      lines: [{ product_id: created.id, qty: 4 }] }, b.cookie);
    expect(res.status).toBe(200);
    const quote = await json(res);
    expect(quote).toMatchObject({ total_minor: 740000, currency: 'MYR', export: { docx: `/api/quotes/${quote.quote_id}/export?format=docx` } });
    expect(JSON.stringify(quote)).not.toContain('99900');
    const stored = await json(await call(`/quotes/${quote.quote_id}`, 'GET', undefined, b.cookie));
    expect(stored.lines[0]).toMatchObject({ qty: 4, unit_price_minor: 185000 });
    const dr = await json(await call(`/design-requests/${quote.design_request_id}`, 'GET', undefined, b.cookie));
    expect(dr).toMatchObject({ customer: 'Air Selangor', subject: 'Lab RFQ', status: 'quoted' });
    expect((await json(await call('/onboarding', 'GET', undefined, b.cookie))).results.quotes).toMatchObject({ quote_id: quote.quote_id });
    expect((await call('/onboarding/quote', 'POST', { request_text: 'x', lines: [{ product_id: created.id, qty: 1 }] })).status).toBe(400);
    expect((await call('/onboarding/quote', 'POST', { request_text: 'x', lines: [{ product_id: created.id, qty: 0 }] }, b.cookie)).status).toBe(400);
    const organize = await json(await call('/onboarding', 'PATCH', { results: { organize: { source: 'csv', product_count: 999 } } }, b.cookie));
    expect(organize.results.organize).toMatchObject({ source: 'csv', product_count: 2 });
  });
});
