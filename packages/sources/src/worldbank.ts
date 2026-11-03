import { z } from 'zod';
import { countryFromName } from './regions';
import { buyerKey, decodeHtml, slug, type FetchFn, type PoolTender } from './types';

/** World Bank procurement notices for Bank-financed projects worldwide (search API v2, no key). */
export const WB_ENDPOINT = 'https://search.worldbank.org/api/v2/procnotices';
/** Notice types that invite bids or interest; contract awards and general procurement notices are not opportunities. */
export const WB_OPEN_TYPES = ['Invitation for Bids', 'Request for Expression of Interest', 'Invitation for Prequalification'];
const LANGS: Record<string, string> = { English: 'ENG', French: 'FRA', Spanish: 'SPA', Portuguese: 'POR', Russian: 'RUS', Arabic: 'ARA', Chinese: 'ZHO' };

const Notice = z.object({
  id: z.string(), notice_type: z.string().optional(), noticedate: z.string().optional(), notice_lang_name: z.string().optional(),
  submission_deadline_date: z.string().optional(), submission_deadline_time: z.string().optional(), project_ctry_name: z.string().optional(),
  project_id: z.string().optional(), project_name: z.string().optional(), bid_reference_no: z.string().optional(), bid_description: z.string().optional(),
  procurement_group: z.string().optional(), procurement_method_name: z.string().optional(), contact_address: z.string().optional(),
  contact_email: z.string().optional(), contact_name: z.string().optional(), contact_organization: z.string().optional(), contact_phone_no: z.string().optional(),
  notice_text: z.string().optional(),
}).passthrough();

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** "02-Nov-2026" -> "2026-11-02T00:00:00.000Z". */
const noticeDate = (d: string | undefined) => {
  const m = /^(\d{2})-([A-Z][a-z]{2})-(\d{4})$/.exec(d ?? '');
  return m && MONTHS[m[2]!] ? `${m[3]}-${MONTHS[m[2]!]}-${m[1]}T00:00:00.000Z` : null;
};
/** The Bank publishes the deadline day plus a local clock time without a zone; the day is kept and the time is recorded, not converted. */
const deadline = (date: string | undefined, time: string | undefined) => {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(date ?? '')?.[1];
  if (!day) return null;
  const tm = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  return `${day}T${tm ? `${tm[1]}:${tm[2]}` : '23:59'}:00.000Z`;
};
const text = (html: string | undefined) => decodeHtml((html ?? '').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

export function mapWorldBankNotice(raw: unknown): PoolTender {
  const n = Notice.parse(raw);
  const country = countryFromName(n.project_ctry_name ?? '');
  const buyer = n.contact_organization?.trim() || (n.project_name ? `${n.project_name} (World Bank-financed)` : 'World Bank-financed project');
  const description = text(n.notice_text).slice(0, 4000) || null;
  return {
    id: `tnd_wb_${slug(n.id)}`, source: 'wb', source_ref: n.id, title: (n.bid_description ?? n.project_name ?? n.id).replace(/\s+/g, ' ').trim().slice(0, 400),
    buyer, buyer_key: buyerKey(buyer), country, cpv: [], value_eur: null, deadline: deadline(n.submission_deadline_date, n.submission_deadline_time),
    url: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${encodeURIComponent(n.id)}`, lots: [], published_at: noticeDate(n.noticedate),
    raw: {
      description, notice_type: n.notice_type ?? null, procurement_method: n.procurement_method_name ?? null, procurement_group: n.procurement_group ?? null,
      official_language: LANGS[n.notice_lang_name ?? ''] ?? null, project: { id: n.project_id ?? null, name: n.project_name ?? null, country_name: n.project_ctry_name ?? null },
      bid_reference: n.bid_reference_no ?? null, deadline_local_time: true,
      contact: { email: n.contact_email, phone: n.contact_phone_no, contact_name: n.contact_name, address: n.contact_address },
    },
  };
}

export interface WbParams { rows?: number; qterm?: string; id?: string; fetch?: FetchFn }

/** Latest open-type notices (newest first). Expired ones are left for the caller's deadline filter. */
export async function searchWorldBank(p: WbParams = {}): Promise<PoolTender[]> {
  const qs = new URLSearchParams({ format: 'json', rows: String(Math.min(p.rows ?? 100, 200)), srt: 'noticedate', order: 'desc' });
  if (p.id) qs.set('id', p.id); else qs.set('notice_type_exact', WB_OPEN_TYPES.join('^'));
  if (p.qterm) qs.set('qterm', p.qterm);
  const res = await (p.fetch ?? fetch)(`${WB_ENDPOINT}?${qs}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`World Bank notices failed: HTTP ${res.status}`);
  const body = await res.json() as { procnotices?: unknown[] };
  const out: PoolTender[] = [];
  for (const raw of body.procnotices ?? []) {
    const ok = Notice.safeParse(raw);
    if (ok.success && (p.id || WB_OPEN_TYPES.includes(ok.data.notice_type ?? ''))) out.push(mapWorldBankNotice(ok.data));
  }
  return out;
}
