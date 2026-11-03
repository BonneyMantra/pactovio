import { z } from 'zod';
import { buyerKey, slug, type FetchFn, type PoolTender } from './types';
import { GBP_EUR } from './fts';

/** UK Contracts Finder (below-threshold and sub-central notices), OCDS search API, no key. */
export const CF_ENDPOINT = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';

const Money = z.object({ amount: z.number(), currency: z.string() }).nullish();
const Release = z.object({
  id: z.string(), date: z.string().optional(),
  parties: z.array(z.object({ name: z.string().optional(), roles: z.array(z.string()).default([]),
    address: z.object({ locality: z.string().optional(), postalCode: z.string().optional(), countryName: z.string().optional() }).passthrough().optional(),
    contactPoint: z.object({ name: z.string().optional(), email: z.string().optional(), telephone: z.string().optional() }).passthrough().optional(),
  }).passthrough()).default([]),
  buyer: z.object({ name: z.string() }).nullish(),
  tender: z.object({
    title: z.string().default(''), description: z.string().optional(), status: z.string().optional(), datePublished: z.string().optional(),
    classification: z.object({ id: z.string(), description: z.string().optional() }).nullish(),
    additionalClassifications: z.array(z.object({ id: z.string(), description: z.string().optional() }).passthrough()).default([]),
    items: z.array(z.object({ classification: z.object({ id: z.string(), description: z.string().optional() }).nullish() }).passthrough()).default([]),
    value: Money, minValue: Money, procurementMethodDetails: z.string().optional(), procurementMethod: z.string().optional(),
    tenderPeriod: z.object({ endDate: z.string().optional() }).nullish(),
    documents: z.array(z.object({ url: z.string().optional() }).passthrough()).default([]),
  }).passthrough(),
}).passthrough();

const iso = (d: string | undefined) => (d && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : null);
const httpUrl = (s: string | undefined) => (s && /^https?:\/\//i.test(s) ? s : undefined);

/** One Contracts Finder OCDS release -> a pool notice (source 'cf'). The notice id is the leading UUID of the release id. */
export function mapCfRelease(raw: unknown): PoolTender {
  const r = Release.parse(raw), t = r.tender;
  const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(r.id)?.[0] ?? r.id;
  const buyerParty = r.parties.find((p) => p.roles.includes('buyer'));
  const buyer = r.buyer?.name ?? buyerParty?.name ?? 'Unknown buyer';
  const classes = [t.classification, ...t.additionalClassifications, ...t.items.map((i) => i.classification)].filter((c): c is { id: string; description?: string } => !!c?.id);
  const cpv = [...new Set(classes.map((c) => c.id))];
  const labels = Object.fromEntries(classes.filter((c) => c.description).map((c) => [c.id, c.description!]));
  const value = t.value ?? t.minValue;
  const eur = value?.currency === 'GBP' ? Math.round(value.amount * GBP_EUR) : value?.currency === 'EUR' ? Math.round(value.amount) : null;
  const description = t.description?.replace(/\s+/g, ' ').trim().slice(0, 1500) || null;
  return {
    id: `tnd_cf_${slug(ref)}`, source: 'cf', source_ref: ref, title: t.title.replace(/\s+/g, ' ').trim() || ref, buyer, buyer_key: buyerKey(buyer),
    country: 'GB', cpv, value_eur: eur, deadline: iso(t.tenderPeriod?.endDate), url: `https://www.contractsfinder.service.gov.uk/Notice/${ref}`,
    lots: [], published_at: iso(t.datePublished ?? r.date),
    raw: {
      description, procurement_method: t.procurementMethodDetails ?? t.procurementMethod ?? null, value_original: value ?? null,
      value_eur_estimated: value?.currency === 'GBP', official_language: 'ENG', cpv_labels: labels,
      contact: { city: buyerParty?.address?.locality, postal_code: buyerParty?.address?.postalCode, email: buyerParty?.contactPoint?.email,
        phone: buyerParty?.contactPoint?.telephone, contact_name: buyerParty?.contactPoint?.name },
      documents_url: httpUrl(t.documents.find((d) => httpUrl(d.url))?.url) ?? null,
    },
  };
}

export interface CfParams { publishedFrom: string; limit?: number; fetch?: FetchFn }

/** Open tender-stage notices published since `publishedFrom` (one page of at most 100). Releases that fail validation are skipped. */
export async function searchContractsFinder(p: CfParams): Promise<PoolTender[]> {
  const url = `${CF_ENDPOINT}?stages=tender&limit=${Math.min(p.limit ?? 100, 100)}&publishedFrom=${encodeURIComponent(p.publishedFrom.slice(0, 19))}`;
  const res = await (p.fetch ?? fetch)(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Contracts Finder failed: HTTP ${res.status}`);
  const body = await res.json() as { releases?: unknown[] };
  const out: PoolTender[] = [];
  for (const rel of body.releases ?? []) {
    const ok = Release.safeParse(rel);
    if (ok.success && (ok.data.tender.status ?? 'active') === 'active') out.push(mapCfRelease(ok.data));
  }
  return out;
}
