import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { createQuote, fmtMinor, priceQuote, quoteDocx, quoteXlsx, loadRules } from '../src';
import { KESTREL, makeSampleEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => ({ env, dispose } = await makeSampleEnv()), 90_000);
afterAll(async () => dispose?.());

const quoted = (r: Promise<unknown>) => r as Promise<Awaited<ReturnType<typeof createQuote>>>;
const run = (o: Parameters<typeof createQuote>[1]) => quoted(createQuote(env, o));

describe('catalogue and rules seed', () => {
  it('seeds the 10 Kestrel products with EUR and INR prices and replaces the placeholders', async () => {
    const r = await env.DB.prepare('SELECT sku, unit_price_minor, specs_json FROM products WHERE workspace_id = ? ORDER BY sku').bind(KESTREL).all<{ sku: string; unit_price_minor: number; specs_json: string }>();
    expect(r.results).toHaveLength(10);
    expect(r.results.map((p) => p.sku)).toContain('VS-210');
    expect(r.results.some((p) => p.sku.startsWith('KS-'))).toBe(false);
    for (const p of r.results) {
      const prices = (JSON.parse(p.specs_json) as { prices: Record<string, number> }).prices;
      expect(prices.EUR).toBe(p.unit_price_minor);
      expect(Number.isInteger(prices.INR) && prices.INR! > 0).toBe(true);
    }
  });
  it('datasheet chunks carry a page marker for citation', async () => {
    const r = await env.DB.prepare("SELECT c.text FROM evidence_chunks c JOIN evidence e ON e.id = c.evidence_id WHERE e.kind = 'datasheet' AND c.text LIKE 'VS-210%'").all<{ text: string }>();
    expect(r.results.length).toBeGreaterThan(8);
    expect(r.results.some((c) => /\[p\.1\] Visibility range \(MOR\) \| 10 m to 75 km/.test(c.text))).toBe(true);
  });
  it('loadRules reads tiers, tax and validity; India switches currency', async () => {
    const ie = await loadRules(env.DB, KESTREL, { country: 'IE', b2b: true });
    expect(ie.rules.currency).toBe('EUR');
    expect(ie.rules.volume_tiers).toHaveLength(3);
    expect(ie.validity_days).toBe(30);
    expect((await loadRules(env.DB, KESTREL, { country: 'IN', b2b: true })).rules.currency).toBe('INR');
  });
});

describe('createQuote', () => {
  it('prices six VS-210 for an Irish buyer: 3% tier, 23% VAT, persisted, quote.ready emitted', async () => {
    const q = await run({ workspaceId: KESTREL, designRequestId: 'dsg_sample_westbay', productIds: ['prd_k_vs210'], qty: 6 });
    expect(q.currency).toBe('EUR');
    expect(q.subtotal_minor).toBe(6 * 295000);
    expect(q.discount_minor).toBe(53100);
    expect(q.tax_minor).toBe(Math.round(((q.subtotal_minor - q.discount_minor) * 2300) / 10000));
    expect(q.total_minor).toBe(q.subtotal_minor - q.discount_minor + q.tax_minor);
    const row = await env.DB.prepare('SELECT total_minor, status, valid_until FROM quotes WHERE id = ?').bind(q.id).first<{ total_minor: number; status: string; valid_until: string }>();
    expect(row?.total_minor).toBe(q.total_minor);
    expect(row?.status).toBe('ready');
    const days = (Date.parse(row!.valid_until) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    const ev = await env.DB.prepare("SELECT payload_json FROM events WHERE type = 'quote.ready'").all<{ payload_json: string }>();
    expect(ev.results.map((e) => JSON.parse(e.payload_json).quote_id)).toContain(q.id);
    expect((await env.DB.prepare('SELECT status FROM design_requests WHERE id = ?').bind('dsg_sample_westbay').first<{ status: string }>())?.status).toBe('quoted');
  });
  it('EU B2B buyer with VAT id: reverse charge, zero tax', async () => {
    const q = await run({ workspaceId: KESTREL, productIds: ['prd_k_vs210', 'prd_k_cb12'], qty: 2, buyer: { country: 'DE', b2b: true, vat_registered: true } });
    expect(q.tax_minor).toBe(0);
    expect(q.total_minor).toBe(q.subtotal_minor - q.discount_minor);
  });
  it('India buyer: INR list prices and 18% GST', async () => {
    const q = await run({ workspaceId: KESTREL, productIds: ['prd_k_dl40'], qty: 10, buyer: { country: 'IN', b2b: true } });
    expect(q.currency).toBe('INR');
    expect(q.lines[0]!.unit_price_minor).toBe(7400000);
    expect(q.discount_minor).toBe(Math.round((10 * 7400000 * 600) / 10000));
    expect(q.tax_minor).toBe(Math.round(((q.subtotal_minor - q.discount_minor) * 1800) / 10000));
  });
  it('refuses to quote an unmatched design request, unknown products and other workspaces', async () => {
    await expect(run({ workspaceId: KESTREL, designRequestId: 'dsg_k_nordwind' })).rejects.toMatchObject({ status: 409 });
    await expect(run({ workspaceId: KESTREL, productIds: ['prd_nope'], qty: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(run({ workspaceId: 'ws_harbour_digital', productIds: ['prd_k_vs210'], qty: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(run({ workspaceId: 'ws_harbour_digital', designRequestId: 'dsg_sample_westbay', productIds: ['prd_k_vs210'] })).rejects.toMatchObject({ status: 404 });
  });
});

describe('export', () => {
  const quote = priceQuote([{ sku: 'VS-210', description: 'VS-210 visibility (fog) sensor', qty: 6, unit_price_minor: 295000 }, { sku: 'GW-4G', description: 'GW-4G gateway & <test>', qty: 6, unit_price_minor: 64000 }], { currency: 'EUR', volume_tiers: [{ min_qty: 5, discount_bp: 300 }], buyer: { country: 'IE', b2b: true } });
  const q = { id: 'quo_test', workspace_id: KESTREL, design_request_id: null, tender_id: null, currency: 'EUR', lines: quote.lines, subtotal_minor: quote.subtotal_minor, discount_minor: quote.discount_minor, tax_minor: quote.tax_minor, total_minor: quote.total_minor, valid_until: '2026-11-29T00:00:00.000Z', status: 'ready' as const };
  const doc = { quote: q, seller: 'Kestrel Sensing Ltd', customer: 'Westbay Port Authority', subject: null, tax_label: 'VAT (Ireland) 23%', tax_bp: 2300 };

  it('formats minor units exactly', () => {
    expect(fmtMinor(0)).toBe('0.00');
    expect(fmtMinor(5)).toBe('0.05');
    expect(fmtMinor(123456789)).toBe('1,234,567.89');
    expect(fmtMinor(-1050)).toBe('-10.50');
  });
  it('DOCX is a valid zip with the lines, escaped text and exact total', () => {
    const files = unzipSync(quoteDocx(doc));
    const xml = strFromU8(files['word/document.xml']!);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']));
    expect(xml).toContain('GW-4G');
    expect(xml).toContain('&amp; &lt;test&gt;');
    expect(xml).toContain(fmtMinor(q.total_minor));
  });
  it('XLSX holds exact decimal totals as numbers', () => {
    const files = unzipSync(quoteXlsx(doc));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain(`<v>${fmtMinor(q.total_minor, false)}</v>`);
    expect(sheet).toContain(`<v>${fmtMinor(q.lines[0]!.line_total_minor, false)}</v>`);
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('name="Quote"');
  });
});
