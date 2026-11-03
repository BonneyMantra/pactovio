import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { imageCandidates, sniffImage } from '../src/lib/product-image';
import { customerFixture } from './customer-fixture';
import { makeEnv } from './helpers';

let env: Env, dispose: () => Promise<void>;
let a: Awaited<ReturnType<typeof customerFixture>>, b: typeof a;
const { app } = buildApp();
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const req = (path: string, init: RequestInit = {}, cookie = a.cookie) => app.fetch(new Request(`https://pactovio.example/api${path}`, {
  ...init, headers: { cookie, origin: 'https://pactovio.example', ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> ?? {}) },
}), env, ctx);
const post = (path: string, body: unknown, cookie = a.cookie) => req(path, { method: 'POST', body: JSON.stringify(body) }, cookie);
const upload = (id: string, bytes: Uint8Array, cookie = a.cookie, type = 'image/png') => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), 'photo.png');
  return req(`/products/${id}/image`, { method: 'POST', body: form }, cookie);
};
const json = async (res: Response) => res.json() as Promise<any>;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const SITE = 'https://www.meridian-instruments.com';
const product = (name: string, sku: string, source_url?: string) => ({ name, sku, family: 'Calibration', unit: 'piece', description: `${name}, factory calibrated`,
  unit_price_minor: 185000, currency: 'MYR', internal_unit_cost_minor: 99900, cost_currency: 'MYR', cost_unit: 'piece', ...(source_url ? { source_url } : {}) });

const pages: Record<string, () => Response> = {
  [`${SITE}/products/pc-40`]: () => new Response(`<html><head><meta property="og:image" content="/media/pc-40.jpg"><meta name="twitter:image" content="https://cdn.shopcdn.net/x.jpg"></head>
    <body><img src="/img/logo.png" width="400" height="400"><img src="/media/pc-40-side.jpg" width="800" height="600"></body></html>`, { headers: { 'content-type': 'text/html' } }),
  [`${SITE}/products/ll-2`]: () => new Response(`<html><body><img src="https://cdn.shopcdn.net/ll-2.jpg" width="900" height="900"></body></html>`, { headers: { 'content-type': 'text/html' } }),
  [`${SITE}/products/fake`]: () => new Response(`<html><head><meta property="og:image" content="/media/fake.jpg"></head></html>`, { headers: { 'content-type': 'text/html' } }),
  [`${SITE}/media/pc-40.jpg`]: () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }),
  [`${SITE}/media/fake.jpg`]: () => new Response('<html>not an image</html>', { headers: { 'content-type': 'image/jpeg' } }),
  [`${SITE}/media/direct.png`]: () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
  [`${SITE}/go-away`]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
};
function stub() {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    seen.push(url.href);
    if (url.hostname === 'cloudflare-dns.com') {
      const host = url.searchParams.get('name')!, v4 = url.searchParams.get('type') === 'A';
      const ip = host.endsWith('meridian-instruments.com') ? '93.184.216.34' : host === 'inside.meridian-labs.com' ? '10.0.0.7' : null;
      return Response.json({ Status: 0, Answer: ip && v4 ? [{ type: 1, data: ip }] : [] });
    }
    return pages[url.href]?.() ?? new Response('not found', { status: 404 });
  }));
  return seen;
}
let p1: any, p2: any, p3: any, p4: any;
beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  a = await customerFixture(env); b = await customerFixture(env);
  p1 = await json(await post('/products', product('Pressure calibrator PC-40', 'PC-40', `${SITE}/products/pc-40`)));
  p2 = await json(await post('/products', product('Laser level LL-2', 'LL-2', `${SITE}/products/ll-2`)));
  p3 = await json(await post('/products', product('Thermometer T-9', 'T-9')));
  p4 = await json(await post('/products', product('Fake image page', 'FK-1', `${SITE}/products/fake`)));
}, 60000);
afterAll(async () => dispose?.());
afterEach(() => vi.unstubAllGlobals());

describe('product image upload and serving', () => {
  it('sniffs magic bytes, stores per workspace and serves only to the owner with cache headers', async () => {
    expect([sniffImage(PNG), sniffImage(JPEG), sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), sniffImage(new TextEncoder().encode('GIF89a......'))])
      .toEqual(['image/png', 'image/jpeg', 'image/webp', null]);
    const revision = () => env.DB.prepare('SELECT revision FROM integration_product_versions WHERE product_id = ?').bind(p3.id).first<{ revision: number }>();
    const before = await revision();
    const res = await upload(p3.id, PNG);
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out).toMatchObject({ product_id: p3.id, content_type: 'image/png', bytes: PNG.byteLength, image_source_url: null });
    expect(out.image_url).toMatch(new RegExp(`^/api/products/${p3.id}/image\\?v=`));
    expect((await revision())?.revision).toBe(before?.revision); // an image is not a catalogue edit
    const img = await req(`/products/${p3.id}/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect((await req(`/products/${p3.id}/image`, { headers: { 'if-none-match': img.headers.get('etag')! } })).status).toBe(304);
    expect((await req(`/products/${p3.id}/image`, {}, b.cookie)).status).toBe(404);
    expect((await upload(p3.id, PNG, b.cookie)).status).toBe(404);
    expect((await req(`/products/${p3.id}/image`, {}, '')).status).toBe(401);
    const listed = (await json(await req('/products'))).items.find((p: any) => p.id === p3.id);
    expect(listed).toMatchObject({ image_url: out.image_url, required_gaps: [] });
    expect(listed.image_key).toBeUndefined();
  });
  it('rejects non-images whatever their declared type, and files over 5 MB', async () => {
    const gif = await upload(p1.id, new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000'), a.cookie, 'image/png');
    expect(gif.status).toBe(415); expect(await json(gif)).toMatchObject({ code: 'unsupported_image' });
    expect((await upload(p1.id, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), a.cookie, 'image/svg+xml')).status).toBe(415);
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(PNG);
    const tooBig = await upload(p1.id, big);
    expect(tooBig.status).toBe(413); expect(await json(tooBig)).toMatchObject({ code: 'image_too_large' });
    expect((await req(`/products/${p1.id}/image`)).status).toBe(404);
  });
  it('reports missing mandatory fields on partially imported products', async () => {
    await env.DB.prepare(`INSERT INTO products (id, workspace_id, sku, name, family, specs_json, unit_price_minor, currency) VALUES ('prd_partial', ?, 'IMP-1', 'Imported valve', NULL, '{}', 5000, 'MYR')`)
      .bind(a.workspace).run();
    const listed = (await json(await req('/products'))).items.find((p: any) => p.id === 'prd_partial');
    expect(listed).toMatchObject({ image_url: null, required_gaps: ['description', 'unit', 'internal_unit_cost', 'cost_currency', 'cost_unit'] });
  });
});

describe('product image fetch from the product page', () => {
  it('takes og:image on the same registrable host through the SSRF guard', async () => {
    stub();
    const res = await post(`/products/${p1.id}/image/fetch`, {});
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ content_type: 'image/jpeg', image_source_url: `${SITE}/media/pc-40.jpg` });
    expect(new Uint8Array(await (await req(`/products/${p1.id}/image`)).arrayBuffer())).toEqual(JPEG);
    expect(imageCandidates('<meta property="og:image" content="https://cdn.shopcdn.net/a.jpg"><img src="/b.webp" width="300" height="300">', new URL(`${SITE}/p`)))
      .toEqual([`${SITE}/b.webp`]);
  });
  it('refuses off-site images, disguised files, private addresses and cross-site redirects', async () => {
    const seen = stub();
    const offsite = await post(`/products/${p2.id}/image/fetch`, {});
    expect(offsite.status).toBe(422); expect(await json(offsite)).toMatchObject({ code: 'no_image_found' });
    const fake = await post(`/products/${p4.id}/image/fetch`, {});
    expect(fake.status).toBe(422); expect(await json(fake)).toMatchObject({ code: 'image_unreadable' });
    for (const url of ['http://127.0.0.1/x.png', 'https://inside.meridian-labs.com/p', `${SITE}:8443/p`, 'file:///etc/passwd']) {
      const r = await post(`/products/${p2.id}/image/fetch`, { url });
      expect(r.status, url).toBe(400); expect((await json(r)).code, url).toBe('invalid_url');
    }
    const redirect = await post(`/products/${p2.id}/image/fetch`, { url: `${SITE}/go-away` });
    expect(redirect.status).toBe(422); expect(await json(redirect)).toMatchObject({ code: 'site_unreadable' });
    expect(seen.some((u) => /127\.0\.0\.1|169\.254|10\.0\.0\.7|^file:/.test(u))).toBe(false);
    expect((await post(`/products/${p3.id}/image/fetch`, {}, b.cookie)).status).toBe(404);
    const noUrl = await post(`/products/${p3.id}/image/fetch`, {});
    expect(noUrl.status).toBe(409); expect(await json(noUrl)).toMatchObject({ code: 'source_url_required' });
    const direct = await json(await post(`/products/${p3.id}/image/fetch`, { url: `${SITE}/media/direct.png` }));
    expect(direct).toMatchObject({ content_type: 'image/png', image_source_url: `${SITE}/media/direct.png` });
  });
  it('bulk-fetches only this workspace\'s products that have a page and no image', async () => {
    stub();
    await post('/products', product('Other workspace gauge', 'OW-1', `${SITE}/products/pc-40`), b.cookie);
    const out = await json(await post('/products/images/fetch-missing', {}));
    expect(out).toMatchObject({ processed: 2, fetched: 0, remaining: 0 });
    expect(out.results.map((r: any) => [r.product_id, r.status, r.code]).sort()).toEqual([[p2.id, 'failed', 'no_image_found'], [p4.id, 'failed', 'image_unreadable']].sort());
    expect(out.without_source_url).toBe(1); // the partial import
    const bItems = (await json(await req('/products', {}, b.cookie))).items;
    expect(bItems[0].image_url).toBeNull();
    expect((await post('/products/images/fetch-missing', { limit: 31 })).status).toBe(400);
  });
});
