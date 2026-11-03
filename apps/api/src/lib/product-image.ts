import { HttpError, PRODUCT_IMAGE_MAX_BYTES } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { decodeHtml } from '@pactovio/sources';
import { randomToken } from './db';
import { fetchPublic, parsePublicUrl, registrableDomain, SiteError } from './site-guard';

/** Product images: sniffed PNG/JPEG/WebP only, <= 5 MB, stored in R2 under the owning workspace, never served across workspaces. */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ProductImageRow { id: string; workspace_id: string; specs_json: string | null; image_key: string | null }

/** Magic bytes decide the type; the declared content type is never trusted. */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const ascii = (from: number, n: number) => String.fromCharCode(...b.slice(from, from + n));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  return null;
}

export const imagePrefix = (ws: string, productId: string) => `products/${ws}/${productId}/`;
export const imageUrl = (id: string, updatedAt: string | null | undefined) => `/api/products/${id}/image${updatedAt ? `?v=${encodeURIComponent(updatedAt)}` : ''}`;

export async function ownProduct(db: D1Database, ws: string, id: string): Promise<ProductImageRow> {
  const row = await db.prepare('SELECT id, workspace_id, specs_json, image_key FROM products WHERE id = ? AND workspace_id = ?').bind(id, ws).first<ProductImageRow>();
  if (!row) throw new HttpError(404, 'Product not found', 'not_found');
  return row;
}

/** The product page recorded on the product (manual `source_url` or an imported link field). */
export function productPageUrl(specsJson: string | null): string | null {
  let specs: Record<string, unknown> = {};
  try { specs = JSON.parse(specsJson ?? '{}') as Record<string, unknown>; } catch { return null; }
  for (const k of ['source_url', 'product_url', 'url', 'link']) {
    const v = specs[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return null;
}

export async function storeImage(env: Env, product: ProductImageRow, bytes: Uint8Array, sourceUrl: string | null) {
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(415, 'Use a PNG, JPEG or WebP image.', 'unsupported_image');
  if (bytes.byteLength > PRODUCT_IMAGE_MAX_BYTES) throw new HttpError(413, 'Images must be 5 MB or smaller.', 'image_too_large');
  const key = `${imagePrefix(product.workspace_id, product.id)}${randomToken(8)}`, at = new Date().toISOString();
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { workspace_id: product.workspace_id, product_id: product.id } });
  // Only replace the image this request started from, so a slow bulk fetch never overwrites a newer upload.
  const res = await env.DB.prepare('UPDATE products SET image_key = ?, image_source_url = ?, image_updated_at = ? WHERE id = ? AND workspace_id = ? AND image_key IS ?')
    .bind(key, sourceUrl, at, product.id, product.workspace_id, product.image_key ?? null).run();
  if (!res.meta.changes) { await env.FILES.delete(key).catch(() => undefined); throw new HttpError(409, 'This product image changed meanwhile. Refresh and try again.', 'image_changed'); }
  if (product.image_key && product.image_key !== key) await env.FILES.delete(product.image_key).catch(() => undefined);
  return { product_id: product.id, image_url: imageUrl(product.id, at), image_source_url: sourceUrl, image_updated_at: at, content_type: type, bytes: bytes.byteLength };
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeHtml(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
};
const SKIP = /(logo|icon|sprite|favicon|avatar|badge|banner-bg|placeholder|spinner|loader|pixel|blank|flag)/i;

/** Ordered candidates: og:image, twitter:image, image_src, JSON-LD Product image, then the largest declared <img>. Same registrable host only. */
export function imageCandidates(html: string, page: URL): string[] {
  const site = registrableDomain(page.hostname), out: string[] = [];
  const add = (raw: string) => {
    if (!raw || /^data:/i.test(raw)) return;
    try {
      const u = new URL(raw, page);
      if (/^https?:$/.test(u.protocol) && registrableDomain(u.hostname) === site && !/\.svg(\?|$)/i.test(u.pathname) && !out.includes(u.href)) out.push(u.href);
    } catch { /* not a URL */ }
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'property') || attr(m[0], 'name')).toLowerCase();
    if (['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'].includes(key)) add(attr(m[0], 'content'));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (/image_src/i.test(attr(m[0], 'rel'))) add(attr(m[0], 'href'));
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const nodes = ([] as unknown[]).concat(JSON.parse(m[1]!.trim())).flatMap((n) => ((n as { '@graph'?: unknown[] })?.['@graph'] ?? [n]));
      for (const n of nodes as Record<string, unknown>[]) {
        if (!([] as unknown[]).concat(n?.['@type'] ?? []).some((t) => /Product/i.test(String(t)))) continue;
        for (const img of ([] as unknown[]).concat(n.image ?? [])) add(typeof img === 'string' ? img : String((img as { url?: unknown })?.url ?? ''));
      }
    } catch { /* malformed JSON-LD */ }
  }
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => {
    const src = attr(m[0], 'src') || attr(m[0], 'data-src') || attr(m[0], 'data-lazy-src');
    const area = (Number(attr(m[0], 'width')) || 0) * (Number(attr(m[0], 'height')) || 0);
    return { src, area, skip: SKIP.test(`${src} ${attr(m[0], 'class')} ${attr(m[0], 'alt')}`) };
  }).filter((x) => x.src && !x.skip && (x.area === 0 || x.area >= 120 * 120)).sort((a, b) => b.area - a.area);
  for (const i of imgs.slice(0, 5)) add(i.src);
  return out.slice(0, 8);
}

const PAGE_OR_IMAGE = { accept: 'text/html,application/xhtml+xml,image/png,image/jpeg,image/webp', maxBytes: PRODUCT_IMAGE_MAX_BYTES, types: /text\/html|application\/xhtml\+xml|image\/(png|jpeg|webp)/i };
const IMAGE = { accept: 'image/png,image/jpeg,image/webp', maxBytes: PRODUCT_IMAGE_MAX_BYTES, types: /^image\/(png|jpe?g|webp)/i };

/** Fetch the product page through the SSRF guard and store its product image. A direct image URL on the same site also works. */
export async function fetchProductImage(env: Env, product: ProductImageRow, rawUrl: string | undefined, fetchFn: typeof fetch = fetch) {
  const pageUrl = rawUrl ?? productPageUrl(product.specs_json);
  if (!pageUrl) throw new HttpError(409, 'Add the product page address first.', 'source_url_required');
  let start: URL;
  try { start = parsePublicUrl(pageUrl); } catch (e) { throw new HttpError(400, e instanceof SiteError ? e.message : 'Enter a valid page address.', 'invalid_url'); }
  const site = registrableDomain(start.hostname), resolved = new Set<string>();
  const fail = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    if (e instanceof SiteError && e.code === 'blocked') throw new HttpError(400, e.message, 'invalid_url');
    throw new HttpError(422, e instanceof SiteError ? e.message : 'The product page could not be read.', 'site_unreadable');
  };
  const first = await fetchPublic(start, site, fetchFn, resolved, PAGE_OR_IMAGE).catch(fail);
  if (first.contentType.startsWith('image/')) {
    if (first.bytes.byteLength > PRODUCT_IMAGE_MAX_BYTES) throw new HttpError(413, 'Images must be 5 MB or smaller.', 'image_too_large');
    return storeImage(env, product, first.bytes, first.url.href);
  }
  const candidates = imageCandidates(new TextDecoder('utf-8').decode(first.bytes), first.url);
  if (!candidates.length) throw new HttpError(422, 'No product image was found on that page.', 'no_image_found');
  for (const href of candidates.slice(0, 3)) {
    try {
      const img = await fetchPublic(new URL(href), site, fetchFn, resolved, IMAGE);
      if (sniffImage(img.bytes)) return await storeImage(env, product, img.bytes, img.url.href);
    } catch (e) { if (e instanceof HttpError) throw e; /* try the next candidate */ }
  }
  throw new HttpError(422, 'The images on that page could not be downloaded as PNG, JPEG or WebP.', 'image_unreadable');
}
