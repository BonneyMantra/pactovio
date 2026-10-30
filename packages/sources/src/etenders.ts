import { decodeHtml, type FetchFn } from './types';

export interface EtendersPack {
  resourceId: string;
  files: { filename: string; r2Key: string }[];
}
export interface EtendersDoc { documentId: string; filename: string }

export interface EtendersOptions {
  bucket: R2Bucket;
  /** Files go to `packs/<tenderId>/<filename>`. */
  tenderId: string;
  /** Portal host: Ireland `www.etenders.gov.ie` (default) or Malta `www.etenders.gov.mt`. */
  host?: string;
  fetch?: FetchFn;
  maxFiles?: number;
  maxBytes?: number;
}

const UA = 'Mozilla/5.0 (compatible; Pactovio/0.1; tender pack reader)';
const REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

/** Documents on a `listContractDocuments.do` page: `downloadDocForAnonymous('9340747')">file.png</a>`. */
export function parseDocumentList(html: string): EtendersDoc[] {
  const out = new Map<string, EtendersDoc>();
  const re = /downloadDocForAnonymous\('(\d+)'\)[^>]*>\s*([^<]+?)\s*<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.set(m[1]!, { documentId: m[1]!, filename: decodeHtml(m[2]!) });
  return [...out.values()];
}

/** Highest page number of the results table, with its display-tag id (`d-5419-p=2`). */
export function listPages(html: string): { tableId: string; pages: number } | null {
  let tableId = '';
  let pages = 1;
  for (const m of html.matchAll(/d-(\d+)-p=(\d+)/g)) {
    tableId = m[1]!;
    pages = Math.max(pages, Number(m[2]));
  }
  return tableId ? { tableId, pages } : null;
}

class Jar {
  private c = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      if (i > 0) this.c.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export const safeFilename = (n: string): string => n.replace(/[\\/\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'document';

function dispositionName(h: string | null): string | null {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) try { return decodeURIComponent(star[1]!); } catch { /* fall through */ }
  const m = /filename="?([^";]+)"?/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/**
 * Anonymous eTenders (EPPS, Ireland and Malta) pack download, no login:
 * listContractDocuments -> prepareAnonymousDownload (sets a session cookie) -> downloadContractDocument.
 * Each file is stored in R2 under `packs/<tenderId>/`. Per-file failures are skipped, not fatal.
 */
export async function fetchEtendersPack(resourceId: string, opts: EtendersOptions): Promise<EtendersPack> {
  if (!/^\d+$/.test(resourceId)) throw new Error('eTenders resourceId must be numeric');
  const f = opts.fetch ?? fetch;
  const base = `https://${opts.host ?? 'www.etenders.gov.ie'}/epps/cft`;
  const jar = new Jar();
  const get = async (url: string, referer?: string): Promise<Response> => {
    const res = await f(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'user-agent': UA, ...(jar.header() ? { cookie: jar.header() } : {}), ...(referer ? { referer } : {}) } });
    jar.absorb(res);
    return res;
  };

  const listUrl = `${base}/listContractDocuments.do?resourceId=${resourceId}`;
  const first = await get(listUrl);
  if (!first.ok) throw new Error(`eTenders list failed: HTTP ${first.status}`);
  const html1 = await first.text();
  const docs = new Map(parseDocumentList(html1).map((d) => [d.documentId, d]));
  const paging = listPages(html1);
  for (let p = 2; paging && p <= Math.min(paging.pages, 6); p++) {
    const res = await get(`${base}/listContractDocuments.do?d-${paging.tableId}-p=${p}&resourceId=${resourceId}`, listUrl);
    if (res.ok) parseDocumentList(await res.text()).forEach((d) => docs.set(d.documentId, d));
  }

  const files: EtendersPack['files'] = [];
  for (const d of [...docs.values()].slice(0, opts.maxFiles ?? DEFAULT_MAX_FILES)) {
    try {
      const prep = await get(`${base}/prepareAnonymousDownload.do?resourceId=${resourceId}&documentId=${d.documentId}`, listUrl);
      await prep.arrayBuffer();
      const res = await get(`${base}/downloadContractDocument.do?documentId=${d.documentId}&resourceId=${resourceId}`, listUrl);
      if (!res.ok) continue;
      if (Number(res.headers.get('content-length') ?? 0) > (opts.maxBytes ?? DEFAULT_MAX_BYTES)) continue;
      if ((res.headers.get('content-type') ?? '').includes('text/html')) continue; // an error or login page, not the file
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > (opts.maxBytes ?? DEFAULT_MAX_BYTES)) continue;
      const filename = safeFilename(dispositionName(res.headers.get('content-disposition')) ?? d.filename);
      const r2Key = `packs/${opts.tenderId}/${filename}`;
      await opts.bucket.put(r2Key, bytes, { httpMetadata: { contentType: res.headers.get('content-type') ?? 'application/octet-stream' } });
      files.push({ filename, r2Key });
    } catch {
      // one bad document must not lose the rest of the pack
    }
  }
  return { resourceId, files };
}
