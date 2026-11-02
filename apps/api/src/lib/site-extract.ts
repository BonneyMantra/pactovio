import { decodeHtml } from '@pactovio/sources';

/** Deterministic, regex-only HTML reading (Workers have no DOM). Every value comes from the fetched page itself. */
export interface PageFacts {
  url: string; title: string; description: string; siteName: string; orgName: string; country: string;
  headings: string[]; links: { text: string; url: string }[]; text: string;
}

const clean = (s: string) => decodeHtml(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeHtml(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
};

function jsonLd(html: string): { name: string; country: string } {
  const out = { name: '', country: '' };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1]!.trim()); } catch { continue; }
    const nodes = (Array.isArray(data) ? data : [data]).flatMap((n) => (n && typeof n === 'object' && Array.isArray((n as { '@graph'?: unknown[] })['@graph']) ? (n as { '@graph': unknown[] })['@graph'] : [n]));
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;
      const types = ([] as unknown[]).concat(n['@type'] ?? []).map(String);
      if (!types.some((t) => /Organization|Corporation|LocalBusiness|Company/i.test(t))) continue;
      if (!out.name && typeof n.name === 'string') out.name = n.name.trim().slice(0, 160);
      const address = ([] as unknown[]).concat(n.address ?? [])[0] as Record<string, unknown> | undefined;
      const c = address?.addressCountry;
      const code = typeof c === 'string' ? c : typeof (c as { name?: unknown })?.name === 'string' ? (c as { name: string }).name : '';
      if (!out.country && /^[A-Za-z]{2}$/.test(code.trim())) out.country = code.trim().toUpperCase();
    }
  }
  return out;
}

export function extractPage(html: string, pageUrl: URL, sameSite: (u: URL) => boolean): PageFacts {
  const ld = jsonLd(html);
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|object)\b[\s\S]*?<\/\1>/gi, ' ');
  const metas = new Map<string, string>();
  for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], 'name') || attr(m[0], 'property')).toLowerCase();
    if (key && !metas.has(key)) metas.set(key, attr(m[0], 'content').slice(0, 600));
  }
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').slice(0, 200);
  const headings = [...new Set([...body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => clean(m[2]!)).filter((h) => h.length >= 2 && h.length <= 120))].slice(0, 40);
  const links: PageFacts['links'] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(` ${m[1]}`, 'href');
    if (!href || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let url: URL;
    try { url = new URL(href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url) || /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4)$/i.test(url.pathname)) continue;
    url.hash = '';
    const text = (clean(m[2]!) || attr(` ${m[1]}`, 'title') || attr(` ${m[1]}`, 'aria-label')).slice(0, 120);
    const key = `${url.pathname}|${text.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    links.push({ text, url: url.href });
    if (links.length >= 300) break;
  }
  return {
    url: pageUrl.href, title, headings, links,
    description: metas.get('description') || metas.get('og:description') || metas.get('twitter:description') || '',
    siteName: metas.get('og:site_name') ?? '', orgName: ld.name, country: ld.country,
    text: clean(body.replace(/<\/(p|div|li|h\d|section|article|br|tr)>/gi, '. ')).replace(/(\.\s*){2,}/g, '. ').slice(0, 6000),
  };
}

const PAGE_PATH = /(^|\/)(products?|solutions?|services?|about(-us)?|industries|sectors|markets|capabilit[a-z]*)(\/|$|[-_])/i;
const OFFER_PATH = /(^|\/)(products?|solutions?|services?|capabilit[a-z]*)(\/|$)/i;
const MARKET_PATH = /(^|\/)(industries|sectors|markets)(\/|$)/i;
const GENERIC = /^(home|products?|solutions?|services?|about( us)?|industries|sectors|markets|capabilities|contact( us)?|learn more|read more|more|view( (all|more|details|products?|product details|datasheets?|brochures?))?|know more|explore more|enquire( now)?|enquiry|(get|request) (a )?quote|click here|(shop|buy) now|download( (the )?(datasheet|brochure|catalogue))?|datasheets?|brochures?|see (all|more)|details|our (products|services|solutions)|all (products|services|solutions)|overview|explore|discover|shop|news|blog|careers|login|sign in|downloads?|support|\W*|[<>»›→]+)$/i;

/** Up to `max` same-site pages worth reading next, one per section family first. */
export function candidatePages(home: PageFacts, max = 4): string[] {
  const picked: string[] = [], families = new Set<string>();
  const ranked = home.links.map((l) => new URL(l.url)).filter((u) => PAGE_PATH.test(u.pathname) && u.pathname.split('/').filter(Boolean).length <= 2);
  for (const pass of [true, false]) {
    for (const u of ranked) {
      const family = PAGE_PATH.exec(u.pathname)![2]!.toLowerCase().replace(/s$/, '');
      const href = `${u.origin}${u.pathname}`;
      if (picked.includes(href) || href === `${new URL(home.url).origin}${new URL(home.url).pathname}`) continue;
      if (pass && families.has(family)) continue;
      families.add(family); picked.push(href);
      if (picked.length >= max) return picked;
    }
  }
  return picked;
}

const named = (pages: PageFacts[], path: RegExp) => {
  const out = new Map<string, string>();
  for (const p of pages) for (const l of p.links) {
    const u = new URL(l.url);
    if (!path.test(u.pathname) || GENERIC.test(l.text) || l.text.length < 3 || l.text.length > 80 || /^\d+$/.test(l.text)) continue;
    // Only deeper links name an item ("/products/laser-levels"), section roots are navigation.
    if (u.pathname.split('/').filter(Boolean).length < 2) continue;
    if (!out.has(l.text.toLowerCase())) out.set(l.text.toLowerCase(), l.text);
  }
  return [...out.values()].slice(0, 20);
};

function pickName(home: PageFacts): string {
  if (home.orgName) return home.orgName;
  if (home.siteName) return home.siteName.slice(0, 160);
  const parts = home.title.split(/\s+[|–—:·-]\s+/).map((s) => s.trim()).filter((s) => s && !/^(home|welcome|homepage)$/i.test(s));
  const label = new URL(home.url).hostname.replace(/^www\./, '').split('.')[0]!.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const match = parts.find((p) => { const k = p.replace(/[^a-z0-9]/gi, '').toLowerCase(); return k && (k.includes(label) || label.includes(k)); });
  return (match ?? parts[0] ?? '').slice(0, 160);
}

const IT = /\b(software|saas|cloud|cyber ?security|it services|managed services|data cent(er|re)|networking|erp|devops|web development|app development|digital transformation)\b/gi;
const INDUSTRIAL = /\b(manufactur\w*|industrial|machiner\w*|equipment|instrument\w*|automation|fabricat\w*|valves?|pumps?|sensors?|plc|cnc|hydraulic\w*|electrical|mechanical|calibration)\b/gi;

export interface DeterministicDraft {
  name?: string; description?: string; offerings: string[]; customers: string[]; markets: string[]; capabilities: string[];
  country?: string; supplier_segment?: 'it' | 'industrial';
}

export function deterministicDraft(pages: PageFacts[]): DeterministicDraft {
  const home = pages[0]!;
  const offerings = named(pages, OFFER_PATH), markets = named(pages, MARKET_PATH);
  const words = pages.map((p) => `${p.title} ${p.headings.join(' ')} ${p.text}`).join(' ');
  const it = words.match(IT)?.length ?? 0, ind = words.match(INDUSTRIAL)?.length ?? 0;
  const segment = it >= 3 && it >= ind * 2 ? 'it' : ind >= 3 && ind >= it * 2 ? 'industrial' : undefined;
  const name = pickName(home), description = home.description.slice(0, 600);
  return {
    ...(name ? { name } : {}), ...(description ? { description } : {}),
    offerings, customers: [], markets, capabilities: offerings.slice(0, 12),
    ...(pages.find((p) => p.country)?.country ? { country: pages.find((p) => p.country)!.country } : {}),
    ...(segment ? { supplier_segment: segment } : {}),
  };
}
