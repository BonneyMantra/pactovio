import { CATALOG, type CatalogItem } from './kestrel-catalog';
import { Doc, type BuiltDoc } from './pdfkit';
import { DEFAULT_TAX } from '../money';
import { pdfMime, SAMPLE_LABEL, type SampleFile } from './types';

export const KESTREL_WS = 'ws_kestrel_sensing';
const F = `Kestrel Sensing Ltd - ${SAMPLE_LABEL}`;

export const VOLUME_TIERS = [{ min_qty: 5, discount_bp: 300 }, { min_qty: 10, discount_bp: 600 }, { min_qty: 25, discount_bp: 1000 }];
export const PRICE_RULES = [
  { id: 'prl_sample_volume', kind: 'volume_discount', rule: { tiers: VOLUME_TIERS, applies_to: 'line' } },
  { id: 'prl_sample_tax', kind: 'tax', rule: DEFAULT_TAX },
  { id: 'prl_k_validity', kind: 'validity', rule: { days: 30 } },
  { id: 'prl_k_currency', kind: 'currency', rule: { default: 'EUR', by_country: { IN: 'INR' } } },
];

const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-IE', { minimumFractionDigits: 2 })}`;

export async function datasheet(p: CatalogItem): Promise<BuiltDoc> {
  const d = await Doc.create(`${p.sku} datasheet`, F);
  d.h1(`${p.sku}  ${p.name.replace(`${p.sku} `, '')}`).p(p.blurb);
  d.h2('Key features').bullets(p.features);
  d.h2('Technical specifications').table([['Parameter', 'Value', 'Notes'], ...p.specs], [2, 3.2, 2]);
  d.h2('Ordering').table([['SKU', 'Description', 'Unit', 'List price EUR'], [p.sku, p.name, p.unit, money(p.eur, 'EUR')]], [1.2, 3.4, 1.2, 1.6]);
  d.p('Kestrel Sensing Ltd, Galway, Ireland, manufacturing in Pune, India. ISO 9001, CE, RoHS. Specifications subject to change without notice. Sample company (fictional): sample data created for demonstration.', 8);
  return d.build();
}

export async function priceList(): Promise<BuiltDoc> {
  const d = await Doc.create('Kestrel price list 2026', F);
  d.h1('Price list 2026').p('Kestrel Sensing Ltd. Effective 1 October 2026. Prices in EUR (Ireland, EU, rest of world) and INR (India). Exclusive of tax.');
  d.table([['SKU', 'Product', 'Unit', 'EUR', 'INR'], ...CATALOG.map((p) => [p.sku, p.name, p.unit, money(p.eur, 'EUR'), money(p.inr, 'INR')])], [1.1, 3.4, 1.2, 1.3, 1.6]);
  d.h2('Commercial rules').bullets([
    'Volume discount per line: 3% at 5 units, 6% at 10 units, 10% at 25 units or more.',
    'Ireland: VAT at 23% on all supplies to Irish customers.',
    'EU business customers with a valid VAT number: reverse charge, 0% VAT, the customer accounts for VAT.',
    'India: GST at 18% on supplies invoiced in INR from our Pune facility.',
    'Other countries outside the EU: zero-rated export, customer pays import duties.',
    'Quotation validity: 30 days from the date of issue. Delivery 8 to 12 weeks from order for sensors; stock items 2 weeks.',
    'Payment: 30 days net on approved credit, otherwise 50% with order and 50% before shipment.',
  ]);
  return d.build();
}

export async function buildKestrel(): Promise<SampleFile[]> {
  const out: SampleFile[] = [];
  for (const p of CATALOG) {
    const b = await datasheet(p);
    out.push({ id: `evd_k_ds_${p.sku.toLowerCase().replace(/[^a-z0-9]/g, '')}`, workspace_id: KESTREL_WS, kind: 'datasheet', title: `${p.sku} datasheet`, issuer: 'Kestrel Sensing Ltd', scope: p.sku, valid_to: null,
      filename: `datasheet-${p.sku.toLowerCase()}.pdf`, mime: pdfMime, bytes: b.bytes, pages: b.pages, meta: { sample: true, company: 'Kestrel Sensing Ltd', sku: p.sku, product_id: p.id } });
  }
  const pl = await priceList();
  out.push({ id: 'evd_k_pricelist', workspace_id: KESTREL_WS, kind: 'price_list', title: 'Price list 2026 (EUR and INR) and commercial rules', issuer: 'Kestrel Sensing Ltd', scope: null, valid_to: '2026-12-31',
    filename: 'price-list-2026.pdf', mime: pdfMime, bytes: pl.bytes, pages: pl.pages, meta: { sample: true, company: 'Kestrel Sensing Ltd' } });
  return out;
}
