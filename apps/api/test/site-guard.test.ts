import { describe, expect, it } from 'vitest';
import { assertResolvesPublic, fetchPublicPage, isPrivateIp, MAX_PAGE_BYTES, parsePublicUrl, registrableDomain, SiteError } from '../src/lib/site-guard';

const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return e instanceof SiteError ? e.code : 'other'; } };
const asyncCode = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof SiteError ? e.code : String(e); } };

/** DNS-over-HTTPS + site transport stand-in. `dns` maps host -> addresses; `pages` maps URL -> Response factory. */
function transport(dns: Record<string, string[]>, pages: Record<string, () => Response>) {
  const log: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://cloudflare-dns.com') {
      const name = url.searchParams.get('name')!, type = url.searchParams.get('type');
      const answers = (dns[name] ?? []).filter((ip) => (type === 'A') === !ip.includes(':')).map((data) => ({ type: type === 'A' ? 1 : 28, data }));
      return Response.json({ Status: 0, Answer: answers });
    }
    log.push(url.href);
    expect(init?.redirect).toBe('manual');
    const page = pages[url.href];
    return page ? page() : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { fn, log };
}
const html = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

describe('website URL guard', () => {
  it('accepts bare domains and public URLs, normalising to https', () => {
    expect(parsePublicUrl('rax-tech.com').href).toBe('https://rax-tech.com/');
    expect(parsePublicUrl('http://www.rax-tech.com/about#team').href).toBe('http://www.rax-tech.com/about');
    expect(parsePublicUrl('https://rax-tech.com:443/').href).toBe('https://rax-tech.com/');
  });
  it('rejects IP literals in every notation, IPv6 and localhost names', () => {
    for (const raw of ['127.0.0.1', 'http://10.0.0.8/', 'https://192.168.1.1', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/',
      'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'localhost',
      'http://localhost:80/', 'https://api.localhost', 'http://intranet/', 'https://db.internal', 'printer.local', 'http://router.home.arpa', 'http://127.0.0.1.nip.io']) {
      expect(code(() => parsePublicUrl(raw)), raw).toBe('blocked');
    }
  });
  it('rejects non-http schemes, credentials and non-standard ports', () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://rax-tech.com/', 'gopher://rax-tech.com', 'ws://rax-tech.com']) {
      expect(code(() => parsePublicUrl(raw)), raw).toBe('invalid_url');
    }
    expect(code(() => parsePublicUrl('https://user:pass@rax-tech.com/'))).toBe('invalid_url');
    expect(code(() => parsePublicUrl('https://rax-tech.com:8443/'))).toBe('blocked');
    expect(code(() => parsePublicUrl('rax-tech.com:22'))).toBe('blocked');
  });
  it('classifies private, mapped and special-purpose addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '198.18.0.1', '224.0.0.1',
      '255.255.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::7f00:1', '2001:db8::1', 'garbage']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['104.21.32.1', '8.8.8.8', '172.32.0.1', '2606:4700::6810:1', '::ffff:8.8.8.8']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('pins registrable domains including two-level public suffixes', () => {
    expect(registrableDomain('www.rax-tech.com')).toBe('rax-tech.com');
    expect(registrableDomain('shop.meridian.com.my')).toBe('meridian.com.my');
    expect(registrableDomain('evil.com.my')).toBe('evil.com.my');
  });
});

describe('guarded page fetch', () => {
  const site = 'rax-tech.com';
  it('refuses a public-looking host whose DNS points inside (rebinding) and fails closed without answers', async () => {
    const t = transport({ 'rax-tech.com': ['93.184.216.34', '10.0.0.5'] }, { 'https://rax-tech.com/': html('<title>x</title>') });
    expect(await asyncCode(fetchPublicPage(new URL('https://rax-tech.com/'), site, t.fn))).toBe('blocked');
    expect(t.log).toEqual([]);
    expect(await asyncCode(assertResolvesPublic('nothing.rax-tech.com', t.fn))).toBe('unreadable');
  });
  it('follows same-site redirects only and re-validates every hop', async () => {
    const dns = { 'rax-tech.com': ['93.184.216.34'], 'www.rax-tech.com': ['93.184.216.34'], 'other.com': ['93.184.216.35'] };
    const ok = transport(dns, {
      'http://rax-tech.com/': () => new Response(null, { status: 301, headers: { location: 'https://www.rax-tech.com/' } }),
      'https://www.rax-tech.com/': html('<title>Rax</title>'),
    });
    const page = await fetchPublicPage(new URL('http://rax-tech.com/'), site, ok.fn);
    expect(page.url.href).toBe('https://www.rax-tech.com/');
    for (const location of ['https://other.com/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'https://rax-tech.com:8080/', 'file:///etc/passwd']) {
      const t = transport(dns, { 'https://rax-tech.com/': () => new Response(null, { status: 302, headers: { location } }) });
      expect(await asyncCode(fetchPublicPage(new URL('https://rax-tech.com/'), site, t.fn)), location).not.toBe('ok');
      expect(t.log, location).toEqual(['https://rax-tech.com/']);
    }
    const loop = transport(dns, { 'https://rax-tech.com/': () => new Response(null, { status: 302, headers: { location: '/' } }) });
    expect(await asyncCode(fetchPublicPage(new URL('https://rax-tech.com/'), site, loop.fn))).toBe('unreadable');
  });
  it('rejects oversized bodies by header and by streamed length, and non-HTML content', async () => {
    const dns = { 'rax-tech.com': ['93.184.216.34'] };
    const declared = transport(dns, { 'https://rax-tech.com/': html('<p>small</p>', { 'content-length': String(MAX_PAGE_BYTES + 1) }) });
    expect(await asyncCode(fetchPublicPage(new URL('https://rax-tech.com/'), site, declared.fn))).toBe('too_large');
    const chunk = new Uint8Array(256 * 1024).fill(97);
    const streamed = transport(dns, { 'https://rax-tech.com/': () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 8; i++) c.enqueue(chunk); c.close(); } }), { headers: { 'content-type': 'text/html' } }) });
    expect(await asyncCode(fetchPublicPage(new URL('https://rax-tech.com/'), site, streamed.fn))).toBe('too_large');
    const pdf = transport(dns, { 'https://rax-tech.com/': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) });
    expect(await asyncCode(fetchPublicPage(new URL('https://rax-tech.com/'), site, pdf.fn))).toBe('not_html');
  });
});
