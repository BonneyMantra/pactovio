import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { matchDesignRequest, type MatchOptions } from '../src';
import { makeSampleEnv } from './helpers';

/** Replays ONE recorded live run (Nemotron-3 Ultra extract + judge on the Westbay port enquiry). Chat responses are the recorded ones; embeddings are a deterministic stand-in driven by the recorded ranking. */
const rec = JSON.parse(readFileSync(resolve(__dirname, '../../../fixtures/samples/recorded/westbay-match.json'), 'utf8')) as {
  trace: { ranks: string[][]; cands: string[] };
  chat: { schema: string; body: unknown }[];
};

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => ({ env, dispose } = await makeSampleEnv()), 90_000);
afterAll(async () => dispose?.());

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

function replayFetch(mutate?: (schema: string, body: any) => void): typeof fetch {
  const queue = rec.chat.map((c) => JSON.parse(JSON.stringify(c)) as { schema: string; body: unknown });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected live call to ${url}`);
    const sent = JSON.parse(String(init?.body)) as { response_format?: { json_schema?: { name?: string } } };
    const next = queue.shift();
    if (!next || next.schema !== sent.response_format?.json_schema?.name) throw new Error(`replay order mismatch: wanted ${next?.schema}, got ${sent.response_format?.json_schema?.name}`);
    mutate?.(next.schema, next.body);
    return new Response(JSON.stringify(next.body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** Chunk j -> basis vector e_j; query i -> weighted sum over its recorded top-4 chunks, so cosine ranking reproduces the recording. */
const embedFn: NonNullable<MatchOptions['embedFn']> = async (texts) => {
  const nq = rec.trace.ranks.length;
  const chunkTexts = texts.slice(nq);
  const dim = chunkTexts.length;
  const basis = (j: number) => Object.assign(new Array<number>(dim).fill(0), { [j]: 1 });
  const idx = new Map(chunkTexts.map((t, j) => [t, j]));
  const q = rec.trace.ranks.map((ranks) => {
    const v = new Array<number>(dim).fill(0);
    ranks.slice(0, 4).forEach((t, r) => { const j = idx.get(t); if (j !== undefined) v[j] = 4 - r; });
    return v;
  });
  return [...q, ...chunkTexts.map((_, j) => basis(j))];
};

const env_ = () => env;

describe('matchDesignRequest (recorded Nemotron run)', () => {
  it('extracts requirements, judges each against datasheet lines with verifiable citations, proposes quote lines, persists', async () => {
    const steps: string[] = [];
    const dr = await matchDesignRequest(env_(), 'dsg_sample_westbay', { fetch: replayFetch(), embedFn, onStep: (s) => { steps.push(s.purpose); } });
    expect(steps).toEqual(['extract requirements', 'judge requirements against datasheets']);
    expect(dr.status).toBe('matched');

    const judged = dr.requirements.filter((r) => r.result);
    expect(judged.length).toBeGreaterThanOrEqual(8);
    const met = judged.filter((r) => r.result!.status === 'MET');
    expect(met.length).toBeGreaterThanOrEqual(4);

    // Every citation is a verbatim datasheet line with a page and a document, checked against the stored chunks.
    const chunks = (await env.DB.prepare("SELECT c.text FROM evidence_chunks c JOIN evidence e ON e.id = c.evidence_id WHERE e.kind = 'datasheet'").all<{ text: string }>()).results.map((c) => norm(c.text));
    const cited = judged.filter((r) => r.result!.citation);
    expect(cited.length).toBeGreaterThanOrEqual(4);
    for (const r of cited) {
      const c = r.result!.citation!;
      expect(c.page).toBeGreaterThanOrEqual(1);
      expect(c.doc).toMatch(/datasheet/);
      expect(c.doc_id).toMatch(/^doc_k_ds_/);
      expect(chunks.some((t) => t.includes(norm(c.quote)))).toBe(true);
    }
    // No MET claim without a citation.
    for (const r of met) expect(r.result!.citation).not.toBeNull();

    const range = dr.requirements.find((r) => r.key === 'range')!.result!;
    expect(range.sku).toBe('VS-210');
    expect(range.status).toBe('MET');
    expect(range.citation!.quote).toMatch(/75 km/);

    const vs = dr.matches.find((m) => m.sku === 'VS-210')!;
    expect(vs.proposed_qty).toBe(6);
    expect(vs.product_id).toBe('prd_k_vs210');
    expect(vs.citations!.length).toBeGreaterThan(0);
    expect(dr.matches.every((m) => m.product_id.startsWith('prd_k_'))).toBe(true);

    const row = await env.DB.prepare('SELECT status, matches_json FROM design_requests WHERE id = ?').bind('dsg_sample_westbay').first<{ status: string; matches_json: string }>();
    expect(row?.status).toBe('matched');
    expect(JSON.parse(row!.matches_json)).toHaveLength(dr.matches.length);
  });

  it('downgrades a MET verdict whose quote is not in the cited datasheet line (no citation, no claim)', async () => {
    const tamper = (schema: string, body: any) => {
      if (schema !== 'verdicts') return;
      const msg = body.choices[0].message;
      const j = JSON.parse(msg.content) as { requirements: { quote: string | null }[] };
      for (const r of j.requirements) if (r.quote) r.quote = `${r.quote} and also 500 km range`;
      msg.content = JSON.stringify(j);
    };
    const dr = await matchDesignRequest(env_(), 'dsg_sample_westbay', { fetch: replayFetch(tamper), embedFn });
    const judged = dr.requirements.filter((r) => r.result);
    expect(judged.every((r) => r.result!.status !== 'MET')).toBe(true);
    expect(judged.every((r) => r.result!.citation === null)).toBe(true);
    expect(judged.some((r) => /no verifiable datasheet quote/.test(r.result!.note))).toBe(true);
  });

  it('rejects an empty spec and an unknown id without calling a model', async () => {
    await env.DB.prepare("UPDATE design_requests SET spec_text = '' WHERE id = 'dsg_k_kilbrook'").run();
    const never = (async () => { throw new Error('live call'); }) as unknown as typeof fetch;
    await expect(matchDesignRequest(env_(), 'dsg_k_kilbrook', { fetch: never })).rejects.toMatchObject({ status: 400 });
    await expect(matchDesignRequest(env_(), 'dsg_nope', { fetch: never })).rejects.toMatchObject({ status: 404 });
  });

  it('falls back to a lexical shortlist when embeddings are unavailable, logging the reason', async () => {
    const steps: { purpose: string; status: string; summary?: string }[] = [];
    const dr = await matchDesignRequest(env_(), 'dsg_sample_westbay', { fetch: replayFetch(), onStep: (s) => { steps.push(s); } });
    expect(dr.status).toBe('matched');
    expect(steps.find((s) => s.purpose === 'embed requirements')).toMatchObject({ status: 'error' });
    expect(steps.find((s) => s.purpose === 'embed requirements')!.summary).toMatch(/lexical/);
  });
});
