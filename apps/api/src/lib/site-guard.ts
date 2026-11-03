/**
 * SSRF guard for the onboarding website reader. Only public http(s) sites on ports 80/443, no IP literals, no internal
 * names, every hostname resolved over DoH and refused if any address is non-public, redirects followed manually and only
 * within the same registrable domain, 8 s per request and a hard body cap.
 */
export type SiteErrorCode = 'invalid_url' | 'blocked' | 'unreadable' | 'too_large' | 'redirect_blocked' | 'not_html';
export class SiteError extends Error {
  constructor(public code: SiteErrorCode, message: string) { super(message); }
}
export const MAX_PAGE_BYTES = 1_500_000;
export const PAGE_TIMEOUT_MS = 8000;
const DOH = 'https://cloudflare-dns.com/dns-query';
const BLOCKED_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'invalid', 'example', 'onion', 'arpa',
  'home.arpa', 'nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me'];
const MULTI_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'com.my', 'net.my', 'org.my', 'com.sg',
  'com.cn', 'co.jp', 'co.in', 'net.in', 'com.br', 'co.nz', 'co.za', 'com.mx', 'com.tr', 'co.kr', 'com.hk', 'com.tw', 'co.id', 'com.ph', 'com.vn', 'com.sa',
  'com.ar', 'co.th', 'com.pk', 'com.ng', 'com.eg', 'co.il', 'com.co']);

/** Accepts "rax-tech.com" or a full URL; returns a normalised public URL or throws SiteError('invalid_url' | 'blocked'). */
export function parsePublicUrl(raw: string): URL {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^(javascript|data|file|mailto|blob|about|vbscript|ftp|gopher|ws|wss):/i.test(text)) text = `https://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { throw new SiteError('invalid_url', 'Enter a website address such as example.com.'); }
  assertPublicUrl(url);
  url.hash = '';
  return url;
}

export function assertPublicUrl(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SiteError('invalid_url', 'Only http and https websites can be read.');
  if (url.username || url.password) throw new SiteError('invalid_url', 'Website addresses with credentials are not accepted.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new SiteError('blocked', 'Only standard web ports (80 and 443) are allowed.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || host.startsWith('[') || host.includes(':')) throw new SiteError('blocked', 'Use a public website name, not an IP address.');
  const labels = host.split('.');
  if (/^[0-9.]+$/.test(host) || /^(0x[0-9a-f]*|\d+)$/i.test(labels.at(-1)!)) throw new SiteError('blocked', 'Use a public website name, not an IP address.');
  if (labels.length < 2 || BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) throw new SiteError('blocked', 'This address is not a public website.');
  if (!labels.every((l) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) throw new SiteError('invalid_url', 'Enter a valid website address.');
}

export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LEVEL.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function v4Private(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    text = text.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation, mapped/NAT64 private and unparseable addresses. */
export function isPrivateIp(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return v4Private(ip);
  const g = expandV6(ip);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  const embedded = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Private(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(embedded);
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0xdb8) || g[0] === 0x100 || g[0] === 0x2002;
}

/** Resolve A and AAAA over DoH. Fails closed: no public answer or any non-public answer refuses the host. */
export async function assertResolvesPublic(host: string, fetchFn: typeof fetch): Promise<void> {
  let addresses = 0;
  for (const type of ['A', 'AAAA']) {
    let body: { Status?: number; Answer?: { type: number; data: string }[] };
    try {
      const res = await fetchFn(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error('dns');
      body = await res.json() as typeof body;
    } catch { throw new SiteError('unreadable', 'The website address could not be resolved.'); }
    for (const a of body.Answer ?? []) {
      if (a.type !== 1 && a.type !== 28) continue;
      if (isPrivateIp(a.data)) throw new SiteError('blocked', 'This address does not point to a public website.');
      addresses++;
    }
  }
  if (!addresses) throw new SiteError('unreadable', 'The website address could not be resolved.');
}

async function readCapped(res: Response, max = MAX_PAGE_BYTES): Promise<Uint8Array> {
  const tooLarge = () => new SiteError('too_large', max === MAX_PAGE_BYTES ? 'The page is larger than 1.5 MB.' : `The file is larger than ${Math.round(max / 1_048_576)} MB.`);
  if (Number(res.headers.get('content-length') ?? 0) > max) { await res.body?.cancel().catch(() => undefined); throw tooLarge(); }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return all;
}

export interface FetchOptions { accept: string; maxBytes: number; types: RegExp }
const HTML: FetchOptions = { accept: 'text/html,application/xhtml+xml', maxBytes: MAX_PAGE_BYTES, types: /text\/html|application\/xhtml\+xml/i };

/** Fetch one HTML page through the guard. `site` is the registrable domain the whole analysis is pinned to. */
export async function fetchPublicPage(start: URL, site: string, fetchFn: typeof fetch, resolved = new Set<string>()): Promise<{ url: URL; html: string }> {
  const got = await fetchPublic(start, site, fetchFn, resolved, HTML);
  return { url: got.url, html: new TextDecoder('utf-8').decode(got.bytes) };
}

/** Guarded fetch of any public resource whose content type matches `opts.types` (pages, product images). */
export async function fetchPublic(start: URL, site: string, fetchFn: typeof fetch, resolved: Set<string>, opts: FetchOptions):
  Promise<{ url: URL; bytes: Uint8Array; contentType: string }> {
  let url = start;
  for (let hop = 0; hop <= 4; hop++) {
    try {
      assertPublicUrl(url);
      if (registrableDomain(url.hostname) !== site) throw new SiteError('redirect_blocked', `The site redirected to another domain (${url.hostname}).`);
      if (!resolved.has(url.hostname)) { await assertResolvesPublic(url.hostname, fetchFn); resolved.add(url.hostname); }
    } catch (e) {
      // The address the customer typed is judged on its own; a redirect into a refused address makes the site unreadable.
      if (hop > 0 && e instanceof SiteError && e.code !== 'redirect_blocked') throw new SiteError('redirect_blocked', 'The site redirected to an address that cannot be read.');
      throw e;
    }
    let res: Response;
    try {
      res = await fetchFn(url.href, { redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: { accept: opts.accept, 'user-agent': 'PactovioSetupReader/1.0 (+https://pactovio.pages.dev)' } });
    } catch { throw new SiteError('unreadable', 'The website did not respond in time.'); }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new SiteError('unreadable', 'The website returned an empty redirect.');
      try { url = new URL(location, url); } catch { throw new SiteError('unreadable', 'The website returned an invalid redirect.'); }
      url.hash = '';
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new SiteError('unreadable', `The website answered with HTTP ${res.status}.`); }
    const type = res.headers.get('content-type') ?? '';
    if (!opts.types.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      throw new SiteError('not_html', opts === HTML ? 'The address is not an HTML page.' : 'The address did not return a supported file type.');
    }
    return { url, bytes: await readCapped(res, opts.maxBytes), contentType: type.split(';')[0]!.trim().toLowerCase() };
  }
  throw new SiteError('unreadable', 'The website redirected too many times.');
}
