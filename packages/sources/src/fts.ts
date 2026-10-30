import { z } from 'zod';
import type { Tender } from '@pactovio/contracts';

type Lot = Tender['lots'][number];
import { buyerKey, cpvMatches, slug, type FetchFn } from './types';

export const FTS_ENDPOINT = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
/** Fixed GBP->EUR rate for the ranking figure only (marked as an estimate in `raw`). */
export const GBP_EUR = 1.15;

const Money = z.object({ amount: z.number(), currency: z.string() }).nullish();
const Release = z.object({
  id: z.string(),
  date: z.string().optional(),
  buyer: z.object({ id: z.string().optional(), name: z.string() }).nullish(),
  tender: z.object({
    title: z.string().default(''),
    description: z.string().optional(),
    classification: z.object({ id: z.string() }).nullish(),
    additionalClassifications: z.array(z.object({ id: z.string(), scheme: z.string().optional() })).default([]),
    value: Money,
    tenderPeriod: z.object({ endDate: z.string().optional() }).nullish(),
    procurementMethod: z.string().optional(),
    lots: z.array(z.object({ id: z.string(), title: z.string().optional(), description: z.string().optional(), value: Money })).default([]),
  }),
});
export type FtsRelease = z.infer<typeof Release>;
const Package = z.object({ releases: z.array(z.unknown()), links: z.object({ next: z.string().optional() }).optional() });

function eur(m: z.infer<typeof Money>): { eur: number | null; estimated: boolean } {
  if (!m) return { eur: null, estimated: false };
  if (m.currency === 'EUR') return { eur: Math.round(m.amount), estimated: false };
  if (m.currency === 'GBP') return { eur: Math.round(m.amount * GBP_EUR), estimated: true };
  return { eur: null, estimated: false };
}

/** Metadata-only mapping of one OCDS release from Find a Tender (UK) to a tenders row. */
export function mapFtsRelease(raw: unknown): Tender {
  const r = Release.parse(raw);
  const t = r.tender;
  const buyer = r.buyer?.name ?? 'Unknown buyer';
  const cpv = [...new Set([t.classification?.id, ...t.additionalClassifications.filter((c) => !c.scheme || c.scheme === 'CPV').map((c) => c.id)].filter((c): c is string => !!c))];
  const total = eur(t.value);
  const lots: Lot[] = t.lots.map((l) => ({
    lot_no: l.id,
    title: l.title ?? (t.lots.length === 1 ? t.title : `Lot ${l.id}`),
    description: l.description?.slice(0, 600),
    value_eur: eur(l.value).eur,
  }));
  return {
    id: `tnd_fts_${slug(r.id)}`,
    source: 'fts',
    source_ref: r.id,
    title: t.title.replace(/[​\s]+/g, ' ').trim() || r.id,
    buyer,
    buyer_key: buyerKey(buyer),
    country: 'GB',
    cpv,
    value_eur: total.eur,
    deadline: t.tenderPeriod?.endDate ? new Date(t.tenderPeriod.endDate).toISOString() : null,
    url: `https://www.find-tender.service.gov.uk/Notice/${r.id}`,
    lots,
    published_at: r.date ? new Date(r.date).toISOString() : null,
    raw: {
      metadata_only: true,
      procurement_method: t.procurementMethod ?? null,
      value_original: t.value ?? null,
      value_eur_estimated: total.estimated,
      description: t.description?.slice(0, 1500) ?? null,
    },
  };
}

export interface FtsParams {
  /** ISO date or datetime; releases updated since then. */
  updatedFrom: string;
  limit?: number;
  /** Keep only releases whose CPV starts with one of these prefixes (the API has no CPV filter). */
  cpvPrefixes?: string[];
  fetch?: FetchFn;
}

/** UK Find a Tender OCDS release packages (tender stage), mapped to tender rows. One page of at most `limit`. */
export async function searchFts(p: FtsParams): Promise<Tender[]> {
  const url = `${FTS_ENDPOINT}?stages=tender&limit=${Math.min(p.limit ?? 100, 100)}&updatedFrom=${encodeURIComponent(p.updatedFrom.slice(0, 19))}`;
  const res = await (p.fetch ?? fetch)(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Find a Tender failed: HTTP ${res.status}`);
  const pkg = Package.parse(await res.json());
  const out: Tender[] = [];
  for (const rel of pkg.releases) {
    if (!Release.safeParse(rel).success) continue;
    const t = mapFtsRelease(rel);
    if (!p.cpvPrefixes || cpvMatches(t.cpv, p.cpvPrefixes)) out.push(t);
  }
  return out;
}
