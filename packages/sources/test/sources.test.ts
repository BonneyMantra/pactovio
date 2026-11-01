import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { makeEnv } from '../../../apps/api/test/helpers';
import { buildTedQuery, fetchEtendersPack, listPages, mapFtsRelease, mapTedNotice, parseDocumentList, searchFts, searchTed } from '../src';

const fx = (n: string) => readFileSync(resolve(__dirname, 'fixtures', n), 'utf8');
const json = (n: string) => JSON.parse(fx(n)) as { notices?: Record<string, unknown>[]; releases?: unknown[] };
const ok = (body: BodyInit, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

describe('TED v3 mapping (recorded)', () => {
  const notices = json('ted-live.json').notices!;
  const teagasc = mapTedNotice(notices.find((n) => n['publication-number'] === '695163-2026') as never);

  it('maps the Teagasc notice: lots, value, deadline, eTenders resource id', () => {
    expect(teagasc).toMatchObject({
      source: 'etenders', source_ref: '695163', title: 'Web applications maintenance support and Development Services',
      buyer: 'Teagasc - the Agriculture and Food Development Authority', buyer_key: 'teagasc_the_agriculture_and_food_development_authority',
      country: 'IRL', value_eur: 5_950_000, deadline: '2026-11-19T13:00:00.000Z', published_at: '2026-10-08T00:00:00.000Z',
      url: 'https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=9239900',
    });
    expect(teagasc.lots.map((l) => l.title)).toEqual(['Lot 1: Multiple Web applications', 'Lot 2: Web application – Nutrient Management Planner NMP', 'Lot 3: Web application – PastureBase Ireland PBI']);
    expect(teagasc.lots.every((l) => l.value_eur === 5_950_000)).toBe(true);
    expect(teagasc.cpv).toContain('72212000');
    expect(new Set(teagasc.cpv).size).toBe(teagasc.cpv.length);
    expect(teagasc.raw).toMatchObject({ resource_id: '9239900', portal: 'www.etenders.gov.ie', ted_publication_number: '695163-2026' });
  });

  it('keeps stable ids so a rescan upserts instead of duplicating', () => {
    expect(mapTedNotice(notices[0] as never).id).toBe(mapTedNotice(notices[0] as never).id);
    expect(teagasc.id).toBe('tnd_etenders_695163');
  });

  it('builds the expert query from CPV prefixes, countries and a publication date', () => {
    expect(buildTedQuery({ since: '2026-10-27', cpvPrefixes: ['72', '50300000'], countries: ['IRL', 'MLT'] })).toBe(
      'publication-date>=20261027 AND (notice-type=cn-standard) AND (buyer-country=IRL OR buyer-country=MLT) AND (classification-cpv=72* OR classification-cpv=50300000)',
    );
  });

  it('searchTed posts the query, skips invalid notices and throws on HTTP errors', async () => {
    let body: Record<string, unknown> = {};
    const fetchOk = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return ok(JSON.stringify({ notices: [...notices, { nonsense: true }], totalNoticeCount: 4 }));
    }) as unknown as typeof fetch;
    const got = await searchTed({ query: 'buyer-country=IRL', limit: 3, fetch: fetchOk });
    expect(got).toHaveLength(notices.length);
    expect(body).toMatchObject({ query: 'buyer-country=IRL', limit: 3, page: 1, paginationMode: 'PAGE_NUMBER' });
    await expect(searchTed({ query: 'x', fetch: (async () => new Response('no', { status: 500 })) as typeof fetch })).rejects.toThrow('HTTP 500');
  });
});

describe('UK Find a Tender OCDS (metadata only)', () => {
  const rels = json('fts-ocds.json').releases!;
  it('maps a release and marks GBP values as estimated euros', () => {
    const t = mapFtsRelease(rels[0]);
    expect(t).toMatchObject({ source: 'fts', source_ref: '102272-2026', country: 'GB', buyer: 'University of Dundee', value_eur: 1_265_000, deadline: '2026-11-30T12:00:00.000Z' });
    expect(t.raw).toMatchObject({ metadata_only: true, value_eur_estimated: true });
    expect(t.url).toBe('https://www.find-tender.service.gov.uk/Notice/102272-2026');
  });
  it('filters by CPV prefix client-side', async () => {
    const f = (async () => ok(JSON.stringify({ releases: rels }))) as unknown as typeof fetch;
    const it = await searchFts({ updatedFrom: '2026-10-20T00:00:00', cpvPrefixes: ['48'], fetch: f });
    expect(it.map((t) => t.source_ref).sort()).toEqual(['102124-2026', '102252-2026']);
  });
});

describe('eTenders anonymous pack download (recorded 3-step flow)', () => {
  const list = fx('etenders-list-9239900.html');
  const prep = fx('etenders-prepare.html');
  const c4t = fx('etenders-c4t.xml');

  it('parses the document list', () => {
    const docs = parseDocumentList(list);
    expect(docs.map((d) => d.filename)).toEqual(['NMP Architecture diagram P4941 LOT2.png', 'P4941 Clarifications 21102026A.pdf', 'P4941_9239900_Web_apps_tender_documents_V2.zip', 'c4t_9239900_1.xml']);
    expect(docs[0]!.documentId).toBe('9340747');
    expect(listPages(list)).toEqual({ tableId: '5419', pages: 1 });
  });

  it('runs list -> prepare (cookie) -> download in order and stores files under packs/<tenderId>/', async () => {
    const calls: string[] = [];
    let cookieSet = false;
    const f = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const h = new Headers(init.headers);
      calls.push(u.pathname.split('/').pop()! + (u.searchParams.get('documentId') ? `:${u.searchParams.get('documentId')}` : ''));
      if (u.pathname.endsWith('listContractDocuments.do')) return ok(list, { headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/epps; Secure; HttpOnly' } });
      if (u.pathname.endsWith('prepareAnonymousDownload.do')) {
        expect(h.get('cookie')).toContain('JSESSIONID=abc123');
        cookieSet = true;
        return ok(prep, { headers: { 'set-cookie': 'G8T=xyz; Path=/' } });
      }
      if (u.pathname.endsWith('downloadContractDocument.do')) {
        if (!cookieSet || !h.get('cookie')?.includes('G8T=xyz')) return ok('<html>login</html>', { headers: { 'content-type': 'text/html' } });
        const id = u.searchParams.get('documentId');
        return ok(c4t, { headers: { 'content-type': 'application/xml', 'content-disposition': `attachment; filename="doc_${id}.xml"` } });
      }
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;
    const stored = new Map<string, number>();
    const bucket = { put: async (k: string, v: ArrayBuffer) => void stored.set(k, v.byteLength) } as unknown as R2Bucket;
    const pack = await fetchEtendersPack('9239900', { bucket, tenderId: 'tnd_x', fetch: f });
    expect(pack.files.map((x) => x.r2Key)).toEqual(['9340747', '9340779', '9339396', '9248114'].map((id) => `packs/tnd_x/doc_${id}.xml`));
    expect(stored.size).toBe(4);
    expect(calls.slice(0, 4)).toEqual(['listContractDocuments.do', 'prepareAnonymousDownload.do:9340747', 'downloadContractDocument.do:9340747', 'prepareAnonymousDownload.do:9340779']);
  });

  it('skips an HTML error page and a failing document without losing the rest', async () => {
    const f = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('listContractDocuments.do')) return ok(list);
      if (u.pathname.endsWith('prepareAnonymousDownload.do')) return ok(prep);
      const id = u.searchParams.get('documentId');
      if (id === '9340747') return ok('<html>session expired</html>', { headers: { 'content-type': 'text/html' } });
      if (id === '9340779') throw new Error('network');
      return ok(c4t, { headers: { 'content-type': 'application/xml' } });
    }) as unknown as typeof fetch;
    const bucket = { put: async () => undefined } as unknown as R2Bucket;
    const pack = await fetchEtendersPack('9239900', { bucket, tenderId: 'tnd_y', fetch: f });
    expect(pack.files.map((x) => x.filename)).toEqual(['P4941_9239900_Web_apps_tender_documents_V2.zip', 'c4t_9239900_1.xml']);
  });

  it('rejects a non-numeric resource id (no URL injection)', async () => {
    await expect(fetchEtendersPack('1&x=2', { bucket: {} as R2Bucket, tenderId: 't' })).rejects.toThrow('numeric');
  });
});

describe('nightly scan (idempotent)', () => {
  let env: Env;
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    ({ env, dispose } = await makeEnv());
    const { customerFixture } = await import('../../../apps/api/test/customer-fixture');
    for (const workspace of ['ws_harbour_digital', 'ws_kestrel_sensing']) {
      await customerFixture(env, workspace);
      await env.DB.prepare('UPDATE company_onboarding SET completed_at = ? WHERE workspace_id = ?').bind(new Date().toISOString(), workspace).run();
    }
  }, 60_000);
  afterAll(async () => dispose?.());

  it('upserts notices, triages once, writes matches and intakes, emits once, and a rerun changes nothing', async () => {
    const { runNightlyScan } = await import('../src');
    const ted = fx('ted-live.json');
    const fts = fx('fts-ocds.json');
    const fetchFake = (async (url: string) => (String(url).includes('api.ted.europa.eu') ? ok(ted) : ok(fts))) as unknown as typeof fetch;
    const triaged: string[] = [];
    const triage = async (ws: { id: string }, t: { source_ref: string }) => {
      triaged.push(`${ws.id}|${t.source_ref}`);
      return { fit_score: t.source_ref === '743624' ? 30 : 82, reason: `fit for ${t.source_ref}`, door: 'tender' as const };
    };
    const opts = { fetch: fetchFake, triage, packs: false, now: new Date('2026-08-01T00:00:00Z') };
    const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

    const first = await runNightlyScan(env, opts);
    expect(first.scanned).toBeGreaterThan(3);
    expect(first.errors).toEqual([]);
    expect(first.matched).toBeGreaterThan(0);
    const matches = await count("SELECT COUNT(*) AS n FROM tender_matches WHERE fit_reason LIKE 'fit for %'");
    expect(matches).toBe(first.triaged);
    expect(await count("SELECT COUNT(*) AS n FROM tender_matches WHERE fit_reason = 'fit for 743624' AND status = 'dismissed'")).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM intakes WHERE source = 'scan' AND id NOT LIKE 'int_sample_%'")).toBe(first.matched);
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE type = 'tender.matched'")).toBe(first.matched);
    expect(await count("SELECT COUNT(*) AS n FROM tenders WHERE source = 'etenders' AND source_ref = '695163'")).toBe(1); // sample row reused
    expect((await env.DB.prepare("SELECT raw_json FROM tenders WHERE id = 'tnd_sample_teagasc_p4941'").first<{ raw_json: string }>())!.raw_json).toContain('"resource_id":"9239900"');

    const tenders = await count('SELECT COUNT(*) AS n FROM tenders');
    const calls = triaged.length;
    const second = await runNightlyScan(env, opts);
    expect(second.new_tenders).toBe(0);
    expect(second.triaged).toBe(0);
    expect(second.matched).toBe(0);
    expect(triaged.length).toBe(calls);
    expect(await count('SELECT COUNT(*) AS n FROM tenders')).toBe(tenders);
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE type = 'tender.matched'")).toBe(first.matched);
    expect(await count("SELECT COALESCE(SUM(count), 0) AS n FROM limits_counters WHERE key = 'scan:runs'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM runs WHERE kind = 'scan'")).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('a failed source or triage call is reported and retried next night, never fatal', async () => {
    const { runNightlyScan } = await import('../src');
    const dead = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;
    const r = await runNightlyScan(env, { fetch: dead, packs: false, workspaceId: 'ws_harbour_digital', triage: async () => { throw new Error('model down'); } });
    expect(r.errors.some((e) => e.startsWith('ted it'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('fts'))).toBe(true);
    expect(r.matched).toBe(0);
  });
});
