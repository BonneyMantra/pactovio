import { describe, expect, it } from 'vitest';
import { buildMatches, normSku, resolveCitation, uniqueKeys, type Cand } from '../src/judge';
import { chunkPages, pageOf } from '../src/chunk';

const cands: Cand[] = [
  { cid: 'C1', text: 'VS-210 [p.1] Visibility range (MOR) | 10 m to 75 km | Reported in metres', title: 'VS-210 datasheet', docId: 'doc_k_ds_vs210' },
  { cid: 'C2', text: 'GW-4G [p.2] Cellular | LTE Cat-4, LTE-M (Cat-M1) | Dual nano-SIM', title: 'GW-4G datasheet', docId: 'doc_k_ds_gw4g' },
];

describe('citations', () => {
  it('accepts a verbatim quote, whitespace and dash insensitive, and resolves the page', () => {
    const c = resolveCitation('C1', '10 m  to 75 km', cands);
    expect(c).toEqual({ doc: 'VS-210 datasheet', doc_id: 'doc_k_ds_vs210', page: 1, quote: '10 m  to 75 km' });
    expect(resolveCitation('C2', 'LTE Cat-4, LTE-M (Cat-M1)', cands)?.page).toBe(2);
  });
  it('rejects invented quotes, wrong candidates, unknown ids and empty input', () => {
    expect(resolveCitation('C1', 'range 10 m to 100 km', cands)).toBeNull();
    expect(resolveCitation('C2', '10 m to 75 km', cands)).toBeNull();
    expect(resolveCitation('C9', '10 m to 75 km', cands)).toBeNull();
    expect(resolveCitation(null, 'x', cands)).toBeNull();
    expect(resolveCitation('C1', 'ab', cands)).toBeNull();
  });
});

describe('buildMatches', () => {
  const products = [{ id: 'p1', sku: 'VS-210', name: 'a' }, { id: 'p2', sku: 'GW-4G', name: 'b' }, { id: 'p3', sku: 'MM-3', name: 'c' }];
  const cit = { doc: 'd', doc_id: null, page: 1, quote: 'q' };
  const reqs = [
    { key: 'range', text: 'range', mandatory: true, result: { status: 'MET' as const, sku: 'VS-210', note: 'ok', citation: cit } },
    { key: 'ip', text: 'ip', mandatory: true, result: { status: 'PARTIAL' as const, sku: 'VS-210', note: 'IP67 not IP68', citation: null } },
    { key: 'comms', text: 'comms', mandatory: true, result: { status: 'MET' as const, sku: 'GW-4G', note: 'ok', citation: cit } },
    { key: 'sil', text: 'SIL2', mandatory: true, result: { status: 'GAP' as const, sku: null, note: 'none', citation: null } },
  ];
  it('scores per product, marks PARTIAL where a requirement is only partly met, and keeps proposed quantities', () => {
    const m = buildMatches(reqs, [{ sku: 'VS-210', qty: 6, why: 'sensor' }, { sku: 'GW-4G', qty: 6, why: 'gw' }, { sku: 'MM-3', qty: 6, why: 'mast requested' }], products);
    const by = Object.fromEntries(m.map((x) => [x.sku, x]));
    expect(by['VS-210']).toMatchObject({ verdict: 'PARTIAL', score: 0.75, proposed_qty: 6 });
    expect(by['VS-210']!.gaps[0]).toMatch(/IP67/);
    expect(by['GW-4G']).toMatchObject({ verdict: 'FIT', score: 1 });
    expect(by['MM-3']).toMatchObject({ verdict: 'FIT', proposed_qty: 6 });
  });
  it('ignores SKUs that are not in the catalogue (model hallucination)', () => {
    const m = buildMatches(reqs, [{ sku: 'ZZ-999', qty: 3, why: 'x' }], products);
    expect(m.find((x) => x.sku === 'ZZ-999')).toBeUndefined();
  });
});

describe('chunking', () => {
  it('datasheet mode: one chunk per table or bullet line with SKU and page prefix', () => {
    const c = chunkPages([['Title', 'Parameter | Value | Notes', 'IP | IP67 | IEC 60529']], { prefix: 'VS-210', perLine: true });
    expect(c.map((x) => x.text)).toEqual(['VS-210 [p.1] Parameter | Value | Notes', 'VS-210 [p.1] IP | IP67 | IEC 60529']);
    expect(pageOf(c[1]!.text)).toBe(1);
  });
  it('document mode: groups lines to ~500 characters per page', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i} with some filler text to take up room in the chunk`);
    const c = chunkPages([lines, ['second page']]);
    expect(c.length).toBeGreaterThan(2);
    expect(c.every((x) => x.text.length < 620)).toBe(true);
    expect(c.at(-1)!.page).toBe(2);
  });
});

describe('model output hygiene', () => {
  it('uniqueKeys suffixes repeated keys so each gets its own verdict', () => {
    expect(uniqueKeys([{ key: 'range' }, { key: 'ip' }, { key: 'range' }, { key: 'range' }]).map((x) => x.key)).toEqual(['range', 'ip', 'range_2', 'range_3']);
  });
  it('normSku takes the first catalogue SKU and rejects N/A and invented SKUs', () => {
    const known = new Set(['VS-210', 'MM-3']);
    expect(normSku('VS-210, MM-3', known)).toBe('VS-210');
    expect(normSku('vs-210', known)).toBe('VS-210');
    expect(normSku('N/A', known)).toBeNull();
    expect(normSku('ZZ-9', known)).toBeNull();
    expect(normSku(null, known)).toBeNull();
  });
});
