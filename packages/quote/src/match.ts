import { z } from 'zod';
import { chatJSON, client, modelFor, costUsd, rankByCosine, liveLimiter, type CallOptions } from '@pactovio/models';
import { fromRow, HttpError, type DesignRequest } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { buildMatches, resolveCitation, type Cand, type Judged } from './judge';

export interface MatchOptions extends Pick<CallOptions, 'onStep' | 'fetch' | 'signal'> {
  /** Override the embedder (tests). */
  embedFn?: (texts: string[]) => Promise<number[][]>;
}

const Extracted = z.object({
  buyer_country: z.string().nullable().describe('ISO 3166-1 alpha-2 country of the buyer, from address or signature'),
  requirements: z.array(z.object({
    key: z.string().describe('snake_case identifier, e.g. visibility_range'),
    text: z.string().describe('one requirement, self-contained, with numbers and units'),
    value: z.string().nullable().describe('the headline value, e.g. "10 m - 10 km"'),
    mandatory: z.boolean(),
  })).min(1).max(20),
});

const Verdicts = z.object({
  requirements: z.array(z.object({
    key: z.string(),
    status: z.enum(['MET', 'PARTIAL', 'GAP']),
    sku: z.string().nullable().describe('the catalogue SKU that best answers this requirement, or null for a GAP'),
    note: z.string().describe('one sentence: what the datasheet says versus what was asked'),
    chunk: z.string().nullable().describe('candidate id such as C7 whose text supports the verdict'),
    quote: z.string().nullable().describe('an exact, verbatim quote from that candidate text'),
  })),
  proposed: z.array(z.object({ sku: z.string(), qty: z.number().int().positive(), why: z.string() })),
});

/** Embed in ONE request (the shared embed() helper pages at 32; the whole corpus is ~130 short lines). */
async function embedOnce(env: Env, texts: string[], o: MatchOptions): Promise<number[][]> {
  if (o.embedFn) return o.embedFn(texts);
  const model = modelFor(env, 'embed');
  const t0 = Date.now();
  const res = await liveLimiter(() => client({ env, fetch: o.fetch }).embeddings.create({ model, input: texts, encoding_format: 'float' }));
  const tokens = res.usage?.prompt_tokens ?? 0;
  await o.onStep?.({ purpose: 'embed requirements and datasheet lines', model, status: 'ok', tokensIn: tokens, tokensOut: 0, tokensCached: 0, ms: Date.now() - t0, costUsd: costUsd(model, tokens, 0) });
  return res.data.map((d) => d.embedding as number[]);
}

const round = (v: number[]) => v.map((x) => Math.round(x * 1e5) / 1e5);

/** Extract requirements (Ultra), shortlist datasheet lines by embedding, judge MET/PARTIAL/GAP with quotes (Ultra), persist. */
export async function matchDesignRequest(env: Env, designRequestId: string, o: MatchOptions = {}): Promise<DesignRequest> {
  const db = env.DB;
  const dr = fromRow<Record<string, unknown>>(await db.prepare('SELECT * FROM design_requests WHERE id = ?').bind(designRequestId).first());
  if (!dr || !dr.id) throw new HttpError(404, 'Design request not found', 'not_found');
  const ws = String(dr.workspace_id);
  const spec = String(dr.spec_text ?? '').trim();
  if (!spec) throw new HttpError(400, 'Design request has no specification text', 'validation');
  const base = { env, onStep: o.onStep, fetch: o.fetch, signal: o.signal };

  const { data: ex } = await chatJSON(Extracted, {
    ...base, role: 'reason', purpose: 'extract requirements', schemaName: 'requirements', temperature: 0, maxTokens: 3000,
    messages: [
      { role: 'system', content: 'You extract technical requirements from a customer enquiry to a sensor manufacturer. List each measurable or checkable requirement separately (range, accuracy, interfaces, protocols, power, environment, ingress, comms, quantity, services, delivery). Always include a requirement with key "quantity" if the number of sites, stations or sets is stated. Do not invent requirements.' },
      { role: 'user', content: `Enquiry from ${dr.customer}:\n\n${spec}` },
    ],
  });
  const requirements = ex.requirements.map((r) => ({ key: r.key, text: r.text, mandatory: r.mandatory, ...(r.value ? { value: r.value } : {}) }));

  const prows = (await db.prepare('SELECT id, sku, name, unit_price_minor, currency, specs_json FROM products WHERE workspace_id = ?').bind(ws).all<Record<string, unknown>>()).results;
  const products = prows.map((p) => ({ id: String(p.id), sku: String(p.sku), name: String(p.name), specs: JSON.parse(String(p.specs_json ?? '{}')) as { unit?: string } }));
  const crows = (await db.prepare("SELECT c.id, c.text, c.embedding_json, e.title, e.meta_json FROM evidence_chunks c JOIN evidence e ON e.id = c.evidence_id WHERE c.workspace_id = ? AND e.kind = 'datasheet' ORDER BY e.id, c.seq").bind(ws).all<Record<string, unknown>>()).results;
  if (!crows.length) throw new HttpError(409, 'No datasheet chunks for this workspace; run the sample seed', 'conflict');
  const chunks = crows.map((c) => {
    const meta = JSON.parse(String(c.meta_json ?? '{}')) as { doc_id?: string | null };
    return { id: String(c.id), text: String(c.text), title: String(c.title), docId: meta.doc_id ?? null, emb: c.embedding_json ? (JSON.parse(String(c.embedding_json)) as number[]) : null };
  });

  const matchable = requirements.filter((r) => r.key !== 'quantity' && r.key !== 'buyer_country');
  const missing = chunks.filter((c) => !c.emb);
  const vectors = await embedOnce(env, [...matchable.map((r) => `${r.text}${r.value ? ` (${r.value})` : ''}`), ...missing.map((c) => c.text)], o);
  const qv = vectors.slice(0, matchable.length);
  missing.forEach((c, i) => { c.emb = vectors[matchable.length + i]!; });
  if (missing.length) await db.batch(missing.map((c) => db.prepare('UPDATE evidence_chunks SET embedding_json = ? WHERE id = ?').bind(JSON.stringify(round(c.emb!)), c.id)));

  const picked = new Map<string, Cand>();
  const ranked = chunks.map((c) => ({ item: c, embedding: c.emb! }));
  qv.forEach((v) => {
    for (const { item } of rankByCosine(v, ranked, 5)) if (!picked.has(item.id)) picked.set(item.id, { cid: `C${picked.size + 1}`, text: item.text, title: item.title, docId: item.docId });
  });
  const cands = [...picked.values()];

  const { data: v } = await chatJSON(Verdicts, {
    ...base, role: 'reason', purpose: 'judge requirements against datasheets', schemaName: 'verdicts', temperature: 0, maxTokens: 5000,
    messages: [
      { role: 'system', content: 'You are a pre-sales engineer. For each requirement decide MET (datasheet value satisfies it), PARTIAL (close, or needs an accessory or caveat), or GAP (no listed product satisfies it). Judge numbers and units strictly. Cite only candidate text, and quote it verbatim. Then propose the quote lines (SKU and quantity) that deliver the whole request: use the stated number of sites or stations as the quantity, include mast, installation days and cloud service only when the enquiry asks for them.' },
      { role: 'user', content: `ENQUIRY (${dr.customer}):\n${spec}\n\nREQUIREMENTS:\n${matchable.map((r) => `- ${r.key}: ${r.text}`).join('\n')}\n\nQUANTITY: ${requirements.find((r) => r.key === 'quantity')?.text ?? 'not stated'}\n\nCATALOGUE:\n${products.map((p) => `- ${p.sku}: ${p.name} (unit: ${p.specs.unit ?? 'each'})`).join('\n')}\n\nDATASHEET CANDIDATES:\n${cands.map((c) => `${c.cid} | ${c.text}`).join('\n')}` },
    ],
  });

  const judged: Judged[] = v.requirements.map((r) => ({ ...r, citation: resolveCitation(r.chunk, r.quote, cands) }));
  const done = requirements.map((r) => {
    const j = judged.find((x) => x.key === r.key);
    if (!j) return r;
    // A MET verdict without a verifiable quote is downgraded: no citation, no claim.
    const status = j.status === 'MET' && !j.citation ? 'PARTIAL' : j.status;
    return { ...r, result: { status, sku: j.sku, note: j.citation || j.status !== 'MET' ? j.note : `${j.note} (no verifiable datasheet quote)`, citation: j.citation } };
  });
  const country = (ex.buyer_country ?? '').toUpperCase();
  if (country.length === 2 && !done.some((r) => r.key === 'buyer_country')) done.push({ key: 'buyer_country', text: `Buyer country: ${country}`, value: country, mandatory: false });
  const matches = buildMatches(done, v.proposed, products);

  await db.prepare("UPDATE design_requests SET requirements_json = ?, matches_json = ?, status = 'matched' WHERE id = ?").bind(JSON.stringify(done), JSON.stringify(matches), designRequestId).run();
  return { id: designRequestId, workspace_id: ws, intake_id: (dr.intake_id as string | null) ?? null, customer: String(dr.customer), subject: String(dr.subject), spec_text: spec, requirements: done, matches, status: 'matched' } as DesignRequest;
}
