import { describe, expect, it } from 'vitest';
import { dedupeReqs, docIdFor, extractLot } from '../src/extract';
import { parsePage } from '../src/lot-pages';

const req = (ref: string, text = 't') => ({ ref, text, kind: 'mandatory' as const, weight: null, word_limit: null, needs_response: false, doc: 'd', page: 1, note: null });
const reply = (model: string, body: unknown, finish = 'stop') => Response.json({ id: 'c', object: 'chat.completion', created: 1, model, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: JSON.stringify(body) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });

type Body = { model: string; messages: { content: string }[]; response_format?: { json_schema: { name: string } } };
/** Answers the section-listing call, then hands every page request to `page`. */
const withSections = (sections: string[], page: (b: Body) => Response) => (async (_u: string | URL | Request, init?: RequestInit) => {
  const b = JSON.parse(String(init?.body)) as Body;
  return b.response_format?.json_schema.name === 'lot_sections' ? reply(b.model, { sections: sections.map((prefix) => ({ prefix, title: prefix })) }) : page(b);
}) as typeof fetch;

describe('lot extraction pages', () => {
  it('reads each section on its own, asks for the next page after the last reference, pack first in every prompt', async () => {
    const prompts: string[] = [];
    const fake = withSections(['B1', 'B2'], (b) => {
      const p = b.messages.at(-1)!.content;
      prompts.push(p);
      if (p.includes('"B1"') && !p.includes('CONTINUE')) return reply(b.model, { requirements: [req('B1.1'), req('B1.2')], has_more: true });
      if (p.includes('"B1"')) return reply(b.model, { requirements: [req('B1.3')], has_more: false });
      return reply(b.model, { requirements: [req('B2.1')], has_more: false });
    });
    const out = await extractLot({ env: { NEBIUS_API_KEY: 'k' } as never, pack: '<tender_pack>PACK</tender_pack>', fetch: fake }, { lot_no: '1', title: 'Apps', response_form_doc: null });
    expect(out.requirements.map((r) => r.ref).sort()).toEqual(['B1.1', 'B1.2', 'B1.3', 'B2.1']);
    expect(prompts).toHaveLength(3); // B1 page 1 + B1 page 2 + B2 (the section listing is answered separately)
    expect(prompts.every((p) => p.startsWith('<tender_pack>PACK</tender_pack>'))).toBe(true);
    const cont = prompts.find((p) => p.includes('CONTINUE'))!;
    expect(cont).toContain('"B1.2"');
  });

  it('falls back to one open pass when no sections are listed, and stops on an empty page (no endless loop)', async () => {
    let pages = 0;
    const fake = withSections([], (b) => { pages++; return reply(b.model, { requirements: [], has_more: true }); });
    const out = await extractLot({ env: { NEBIUS_API_KEY: 'k' } as never, pack: 'P', fetch: fake }, { lot_no: '2', title: 'x', response_form_doc: null });
    expect(out.requirements).toEqual([]);
    expect(pages).toBe(1);
  });
});

describe('truncated pages are salvaged, not lost', () => {
  const full = JSON.stringify({ requirements: [req('B2.1', 'first, with "quotes" and {braces}'), req('B2.2'), req('B2.3')], has_more: false });
  it('a whole answer is read as is, and invalid entries are skipped individually', () => {
    expect(parsePage(full, false).reqs.map((r) => r.ref)).toEqual(['B2.1', 'B2.2', 'B2.3']);
    const bad = JSON.stringify({ requirements: [req('B1'), { ref: 'B2' }], has_more: false });
    expect(parsePage(bad, false).reqs.map((r) => r.ref)).toEqual(['B1']);
  });
  it('cuts an answer that stopped mid-object after the last complete requirement and asks for more', () => {
    const cut = full.slice(0, full.indexOf('"B2.3"') + 14);
    const p = parsePage(cut, true);
    expect(p.reqs.map((r) => r.ref)).toEqual(['B2.1', 'B2.2']);
    expect(p.hasMore).toBe(true);
    expect(parsePage('```json\n' + full + '\n```', false).hasMore).toBe(false);
  });
  it('extractLot continues after a page cut off by the token limit', async () => {
    const calls: string[] = [];
    const fake = withSections(['C'], (b) => {
      calls.push(b.messages.at(-1)!.content);
      if (calls.length === 1) {
        const cut = '{"requirements":[' + JSON.stringify(req('C1')) + ',' + JSON.stringify(req('C2')) + ',{"ref":"C3","te';
        return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: b.model, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: cut } }], usage: { prompt_tokens: 10, completion_tokens: 12000 } });
      }
      return reply(b.model, { requirements: [req('C3'), req('C4')], has_more: false });
    });
    const out = await extractLot({ env: { NEBIUS_API_KEY: 'k' } as never, pack: 'P', fetch: fake }, { lot_no: '3', title: 'x', response_form_doc: null });
    expect(out.requirements.map((r) => r.ref)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(calls[1]).toContain('"C2"');
  });
});

describe('extraction helpers', () => {
  it('dedupeReqs keeps one entry per reference, preferring the fuller text', () => {
    const out = dedupeReqs([req('B1.1', 'short'), req('b1.1', 'a much longer requirement text'), req('B1.2')]);
    expect(out.map((r) => r.ref)).toEqual(['b1.1', 'B1.2']);
  });
  it('docIdFor resolves the filename the model cited, tolerating a path prefix, and returns null for unknown files', () => {
    const docs = [{ docId: 'doc_a', filename: 'Pack/TRD LOT1.docx' }, { docId: 'doc_b', filename: 'CFT.docx' }];
    expect(docIdFor(docs, 'cft.docx')).toBe('doc_b');
    expect(docIdFor(docs, 'TRD LOT1.docx')).toBe('doc_a');
    expect(docIdFor(docs, 'other.pdf')).toBeNull();
  });
});

describe('sections that are gates or form boilerplate are not re-read', () => {
  it('skips listed gate refs and tenderer-summary sections, reads the rest', async () => {
    const read: string[] = [];
    const fake = (async (_u: string | URL | Request, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Body;
      if (b.response_format?.json_schema.name === 'lot_sections') return reply(b.model, { sections: [{ prefix: 'A1.1', title: 'Tenderer summary' }, { prefix: 'A2', title: 'Financial' }, { prefix: 'A4', title: 'Insurances' }, { prefix: 'A6', title: 'Technical requirements' }, { prefix: 'B1', title: 'Method statement' }] });
      read.push(/starts with "([^"]+)"/.exec(b.messages.at(-1)!.content)![1]!);
      return reply(b.model, { requirements: [], has_more: false });
    }) as typeof fetch;
    await extractLot({ env: { NEBIUS_API_KEY: 'k' } as never, pack: 'P', fetch: fake }, { lot_no: '1', title: 'x', response_form_doc: null }, ['A2', 'A4']);
    expect(read.sort()).toEqual(['A6', 'B1']);
  });
});
