import type { Env } from '@pactovio/contracts/env';
import { chat, type StepLogger } from '@pactovio/models';
import { z } from 'zod';
import { ExtractedReq, LotRequirements } from './schemas';

const strip = (t: string) => t.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/** Complete top-level objects of the `requirements` array in a (possibly truncated) JSON answer. */
function completeObjects(text: string): unknown[] {
  const start = text.indexOf('[', text.indexOf('"requirements"'));
  if (start < 0) return [];
  const out: unknown[] = [];
  let depth = 0, inStr = false, esc = false, from = -1;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) from = i; }
    else if (c === '}') {
      if (--depth === 0 && from >= 0) {
        try { out.push(JSON.parse(text.slice(from, i + 1))); } catch { /* skip a malformed object */ }
        from = -1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  return out;
}

export interface Page { reqs: ExtractedReq[]; hasMore: boolean }

/**
 * Read one page of requirements. A whole, valid answer is used as is; an answer cut off by the token limit is
 * salvaged object by object and treated as "more to come", so a verbose lot still makes progress instead of failing.
 */
export function parsePage(text: string, truncated: boolean): Page {
  const t = strip(text);
  let objs: unknown[];
  let hasMore = true;
  try {
    const whole = JSON.parse(t) as { requirements?: unknown[]; has_more?: boolean };
    objs = Array.isArray(whole.requirements) ? whole.requirements : [];
    hasMore = whole.has_more === true;
  } catch {
    objs = completeObjects(t);
    hasMore = true;
  }
  if (truncated) hasMore = true;
  const reqs = objs.flatMap((o) => { const r = ExtractedReq.safeParse(o); return r.success ? [r.data] : []; });
  return { reqs, hasMore };
}

const MAX_TOKENS = 12000;
const MAX_PAGES = 12;

export async function readPages(
  c: { env: Env; onStep?: StepLogger; fetch?: typeof fetch },
  o: { lot: string; system: string; pack: string; base: string },
): Promise<ExtractedReq[]> {
  const schema = z.toJSONSchema(LotRequirements, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  const out: ExtractedReq[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const last = out.at(-1);
    const task = last ? `${o.base}\n\nCONTINUE: you already returned ${out.length} requirements, the last one with ref "${last.ref}". Return the ones that come AFTER it, none of the earlier ones.` : o.base;
    const res = await chat({
      env: c.env, role: 'reason', purpose: `Whole-pack extraction: Lot ${o.lot} requirements${page > 1 ? ` (page ${page})` : ''}`,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: `${o.pack}\n\nTASK\n${task}` }],
      maxTokens: MAX_TOKENS, timeoutMs: 900_000, onStep: c.onStep, fetch: c.fetch,
      extra: { chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_schema', json_schema: { name: 'lot_requirements', strict: true, schema } } },
    });
    const finish = (res.raw as { choices?: { finish_reason?: string }[] }).choices?.[0]?.finish_reason;
    const p = parsePage(res.text, finish === 'length');
    const fresh = p.reqs.filter((r) => { const k = r.ref.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    out.push(...fresh);
    if (!p.hasMore || !fresh.length) break;
  }
  return out;
}
