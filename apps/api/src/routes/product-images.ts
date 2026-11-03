import { Hono, type Context } from 'hono';
import { HttpError, ImageFetchInput, ImagesFetchMissingInput, PRODUCT_IMAGE_MAX_BYTES } from '@pactovio/contracts';
import { takeLimit } from '../lib/customer-security';
import { customerAuth } from '../lib/customer-session';
import { fetchProductImage, imagePrefix, ownProduct, productPageUrl, storeImage, type ProductImageRow } from '../lib/product-image';
import { errorResponse } from '../lib/router';
import type { AppEnv } from '../lib/types';

/** /api/products image routes (customer session only; every lookup is scoped to the session's workspace). */
export const productImageRoutes = new Hono<AppEnv>();
type Handler = (c: Context<AppEnv>, ws: string) => Promise<Response>;
const authed = (fn: Handler) => async (c: Context<AppEnv>) => {
  try {
    const auth = await customerAuth(c);
    c.set('auth', auth);
    return await fn(c, auth.workspaceId);
  } catch (e) { c.header('cache-control', 'no-store'); return errorResponse(c, e); }
};
async function json<T>(c: Context<AppEnv>, parse: (v: unknown) => T): Promise<T> {
  const text = await c.req.text();
  if (text.length > 8_000) throw new HttpError(413, 'The request is too large.', 'body_too_large');
  try { return parse(text ? JSON.parse(text) : {}); } catch (e) { if (e instanceof SyntaxError) throw new HttpError(400, 'Send a JSON request body.', 'validation'); throw e; }
}

productImageRoutes.post('/images/fetch-missing', authed(async (c, ws) => {
  const input = await json(c, (v) => ImagesFetchMissingInput.parse(v));
  await takeLimit(c.env.DB, `product-images-bulk:${ws}`, 6, 3600);
  const rows = (await c.env.DB.prepare('SELECT id, workspace_id, specs_json, image_key FROM products WHERE workspace_id = ? AND image_key IS NULL ORDER BY family, sku LIMIT 2000')
    .bind(ws).all<ProductImageRow>()).results;
  const withUrl = rows.filter((r) => productPageUrl(r.specs_json));
  // At most 10 per run keeps DNS checks + page + image fetches inside the Worker subrequest limit.
  const batch = withUrl.slice(0, Math.min(input.limit ?? 10, 10));
  const results: { product_id: string; status: 'fetched' | 'failed'; code?: string; image_url?: string }[] = [];
  // Three at a time keeps the run inside the Worker subrequest budget (each product: DNS checks, the page, one image).
  for (let i = 0; i < batch.length; i += 3) {
    await Promise.all(batch.slice(i, i + 3).map(async (row) => {
      try {
        const out = await fetchProductImage(c.env, row, undefined);
        results.push({ product_id: row.id, status: 'fetched', image_url: out.image_url });
      } catch (e) {
        results.push({ product_id: row.id, status: 'failed', code: e instanceof HttpError ? e.code ?? 'error' : 'error' });
      }
    }));
  }
  c.header('cache-control', 'no-store');
  return c.json({ results, processed: batch.length, fetched: results.filter((r) => r.status === 'fetched').length,
    remaining: withUrl.length - batch.length, without_source_url: rows.length - withUrl.length });
}));

productImageRoutes.post('/:id/image/fetch', authed(async (c, ws) => {
  const input = await json(c, (v) => ImageFetchInput.parse(v));
  const product = await ownProduct(c.env.DB, ws, (c.req.param('id') ?? '').slice(0, 80));
  await takeLimit(c.env.DB, `product-image-fetch:${ws}`, 60, 3600);
  c.header('cache-control', 'no-store');
  return c.json(await fetchProductImage(c.env, product, input.url));
}));

productImageRoutes.post('/:id/image', authed(async (c, ws) => {
  if (Number(c.req.header('content-length') ?? 0) > PRODUCT_IMAGE_MAX_BYTES + 64_000) throw new HttpError(413, 'Images must be 5 MB or smaller.', 'image_too_large');
  const product = await ownProduct(c.env.DB, ws, (c.req.param('id') ?? '').slice(0, 80));
  await takeLimit(c.env.DB, `product-image-upload:${ws}`, 120, 3600);
  // Read at most the size limit (+ multipart overhead) even when no content-length was sent, then parse the form.
  const body = await cappedBody(c.req.raw, PRODUCT_IMAGE_MAX_BYTES + 64_000);
  const form = await new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body }).formData().catch(() => null);
  const file = form?.get('file') ?? form?.get('image');
  if (!form || !(file instanceof File)) throw new HttpError(400, 'Send multipart form data with a "file" field.', 'validation');
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) throw new HttpError(413, 'Images must be 5 MB or smaller.', 'image_too_large');
  c.header('cache-control', 'no-store');
  return c.json(await storeImage(c.env, product, new Uint8Array(await file.arrayBuffer()), null));
}));

productImageRoutes.get('/:id/image', authed(async (c, ws) => {
  const product = await ownProduct(c.env.DB, ws, (c.req.param('id') ?? '').slice(0, 80));
  // The key is re-checked against the workspace prefix so a stray row can never serve another workspace's object.
  if (!product.image_key || !product.image_key.startsWith(imagePrefix(ws, product.id))) throw new HttpError(404, 'This product has no image yet.', 'not_found');
  const obj = await c.env.FILES.get(product.image_key);
  if (!obj) throw new HttpError(404, 'This product has no image yet.', 'not_found');
  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'private, max-age=86400',
    etag: obj.httpEtag, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline',
  });
  if (c.req.header('if-none-match') === obj.httpEtag) { await obj.body.cancel().catch(() => undefined); return new Response(null, { status: 304, headers }); }
  return new Response(obj.body, { headers });
}));

async function cappedBody(req: Request, max: number): Promise<Uint8Array> {
  const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw new HttpError(413, 'Images must be 5 MB or smaller.', 'image_too_large'); }
    parts.push(value);
  }
  const out = new Uint8Array(total); let at = 0; for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
