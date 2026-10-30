import { describe, expect, it } from 'vitest';
import { dedupeReqs, docIdFor, extractLot } from '../src/extract';

const req = (ref: string, text = 't') => ({ ref, text, kind: 'mandatory', weight: null, word_limit: null, needs_response: false, doc: 'd', page: 1, note: null });
const reply = (model: string, body: unknown) => Response.json({ id: 'c', object: 'chat.completion', created: 1, model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(body) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });

describe('lot extraction pages', () => {
  it('asks for the next page after the last reference until has_more is false, pack first in every prompt', async () => {
    const prompts: string[] = [];
    const fake = (async (_u: string | URL | Request, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      prompts.push(b.messages.at(-1)!.content);
      return prompts.length === 1 ? reply(b.model, { requirements: [req('B1.1'), req('B1.2')], has_more: true }) : reply(b.model, { requirements: [req('B1.3')], has_more: false });
    }) as typeof fetch;
    const out = await extractLot({ env: { NEBIUS_API_KEY: 'k' } as never, pack: '<tender_pack>PACK</tender_pack>', fetch: fake }, { lot_no: '1', title: 'Apps', response_form_doc: null });
    expect(out.requirements.map((r) => r.ref)).toEqual(['B1.1', 'B1.2', 'B1.3']);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((p) => p.startsWith('<tender_pack>PACK</tender_pack>'))).toBe(true);
    expect(prompts[1]).toContain('CONTINUE');
    expect(prompts[1]).toContain('"B1.2"');
  });

  it('stops on an empty page even if the model claims there is more (no endless loop)', async () => {
    let n = 0;
    const fake = (async (_u: string | URL | Request, init?: RequestInit) => { n++; return reply(JSON.parse(String(init?.body)).model, { requirements: [], has_more: true }); }) as typeof fetch;
    const out = await extractLot({ env: { NEBIUS_API_KEY: 'k' } as never, pack: 'P', fetch: fake }, { lot_no: '2', title: 'x', response_form_doc: null });
    expect(out.requirements).toEqual([]);
    expect(n).toBe(1);
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
