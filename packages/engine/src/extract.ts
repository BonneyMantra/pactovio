import type { Env } from '@pactovio/contracts/env';
import { chatJSON, type StepLogger } from '@pactovio/models';
import { LotRequirements, Overview, type ExtractedReq } from './schemas';

export const SYSTEM = `You are the bid analyst inside Pactovio. You read a complete public tender pack and return exact structured data.
Rules: use only what the pack says; keep reference numbers exactly as printed; page numbers come from the [page N] markers; document names must be the exact filename after "=== DOCUMENT:". Clarifications issued after the original documents OVERRIDE conflicting original text: when a clarification changes a value or requirement, use the clarified value and say so in the note. Never invent requirements. Output JSON only.`;

interface Common { env: Env; pack: string; onStep?: StepLogger; fetch?: typeof fetch }

/** Pack first, then the task: the prefix is identical across the calls of a run, so later calls hit the prompt cache. */
const messages = (pack: string, task: string) => [
  { role: 'system' as const, content: SYSTEM },
  { role: 'user' as const, content: `${pack}\n\nTASK\n${task}` },
];

const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };

export async function extractOverview(c: Common) {
  const task = `Return the tender overview.
- lots: every lot with its number, title, estimated value in whole euros (use clarified values) and the filename of its tenderer response form if there is one.
- gates: every PASS/FAIL selection criterion: financial standing / turnover, insurance (one gate per cover type, each with its own limit, ref like "A4 public liability"), references, named certifications, exclusion grounds, tax compliance, health and safety, professional ability. kind: "turnover", "insurance", "references", "exclusion"; "certification" ONLY for a named standard or accreditation (ISO 27001, Cyber Essentials, CE marking); tax clearance, health and safety, tenderer summary and technical ability are "other". lot = null when the criterion applies to all lots. Lift numbers exactly (turnover in whole euros and over how many years, cover limits in whole euros, number of references and look-back years). remediable = true when the pack lets the tenderer hold the cover or document only if successful or by award.
- deadlines: submission deadline, clarification query deadline, any other dated milestone (ISO 8601; times are Irish local = GMT/UTC unless the pack says otherwise).
- submission_deadline: the closing date/time for tender responses.
- clarifications: every numbered clarification with the query, the buyer response, and what it affects.
- forms: every document the tenderer must complete and return.`;
  return chatJSON(Overview, {
    env: c.env, role: 'reason', purpose: 'Whole-pack overview: lots, gates, deadlines, clarifications', schemaName: 'overview',
    messages: messages(c.pack, task), maxTokens: 14000, timeoutMs: 600_000, onStep: c.onStep, fetch: c.fetch, extra: NO_THINK,
  });
}

const PAGE = 60;
const MAX_PAGES = 6;

/**
 * Requirements of one lot, in pages of up to 60 in document order. One long answer used to hit the output limit and
 * come back truncated; each page restarts after the last reference returned, with the pack prefix cached.
 */
export async function extractLot(c: Common, lot: { lot_no: string; title: string; response_form_doc: string | null }): Promise<{ requirements: ExtractedReq[] }> {
  const form = lot.response_form_doc ? `Its response form is "${lot.response_form_doc}".` : '';
  const base = `Extract the requirements for LOT ${lot.lot_no} (${lot.title}). ${form}
Sources: the Requirements and Specifications document, the lot's response form tables (Ref No., Requirements, Mandatory/Desirable, compliance, comments), and the award criteria in the call for tender.
- kind: "mandatory" = must / M / pass-fail; "scored" = weighted award criterion or desirable (D) item that earns marks, or a written method statement that is scored; "info" = headings, form-completion instructions and background that need no response.
- weight: percentage of the award marks the criterion carries when stated, else null.
- needs_response: true ONLY when the tenderer writes a narrative answer in a free-text box. False for price and cost tables, rate cards, yes/no confirmations, CV and staff tables.
- word_limit: only when stated for that item.
- text: the requirement as written, shortened to at most 60 words when longer (keep the reference exact).
- Skip the pass/fail selection criteria themselves (A1 tenderer summary, A2 financial, A3 tax, A4 insurance, A5 health and safety, A6 technical ability as headings, A7 references), they are handled separately; DO include their numbered sub-requirements (A.6.1 and so on) and everything in Sections B. Skip requirements that belong to other lots.
- Apply clarifications that change a requirement and cite them in note.
One entry per reference number, in the order they appear in the response form. Return at most ${PAGE} per answer and set has_more.`;
  const out: ExtractedReq[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const last = out.at(-1);
    const task = last ? `${base}

CONTINUE: you already returned ${out.length} requirements, the last one with ref "${last.ref}". Return the next ${PAGE} that come AFTER it, none of the earlier ones.` : base;
    const { data } = await chatJSON(LotRequirements, {
      env: c.env, role: 'reason', purpose: `Whole-pack extraction: Lot ${lot.lot_no} requirements${page > 1 ? ` (page ${page})` : ''}`, schemaName: 'lot_requirements',
      messages: messages(c.pack, task), maxTokens: 24000, timeoutMs: 900_000, onStep: c.onStep, fetch: c.fetch, extra: NO_THINK,
    });
    out.push(...data.requirements);
    if (!data.has_more || !data.requirements.length) break;
  }
  return { requirements: out };
}

/** Resolve the filename the model cited to a document id; unknown names map to null. */
export function docIdFor(docs: { docId: string; filename: string }[], filename: string): string | null {
  const f = filename.trim().toLowerCase();
  return docs.find((d) => d.filename.toLowerCase() === f)?.docId ?? docs.find((d) => f && d.filename.toLowerCase().includes(f.replace(/^.*\//, '')))?.docId ?? null;
}

/** Drop duplicate refs within a lot (keep the first, longest text wins on ties). */
export function dedupeReqs(reqs: ExtractedReq[]): ExtractedReq[] {
  const seen = new Map<string, ExtractedReq>();
  for (const r of reqs) {
    const k = r.ref.trim().toLowerCase();
    const prev = seen.get(k);
    if (!prev || r.text.length > prev.text.length) seen.set(k, r);
  }
  return [...seen.values()];
}

const lotKey = (s: string | null): string | null => (s == null ? null : (/\d+/.exec(s)?.[0] ?? s.trim()));
/** Cover the buyer lets the tenderer arrange after award: "holds, or will hold should they be successful", "required to hold for the term". */
export const AFTER_AWARD = /(?:will hold[^.]{0,60}successful|shall be required to hold|required to hold for the term|hold(?:s)?,? or will hold)/i;

/**
 * Clean the model's overview: lot numbers are digits only ("Lot 1" -> "1"), per-lot copies of a gate that already
 * applies to every lot are dropped, and insurance gates are remediable when the pack text says cover may be arranged
 * after award (decided from the text by a rule, not left to the model).
 */
export function normaliseOverview(o: Overview, packText: string): Overview {
  const lots = o.lots.map((l) => ({ ...l, lot_no: lotKey(l.lot_no) ?? l.lot_no }));
  const all = o.gates.map((g) => ({ ...g, lot: lotKey(g.lot) }));
  const afterAward = AFTER_AWARD.test(packText);
  const gates = all
    .filter((g, i) => g.lot === null || !all.some((h, j) => j !== i && h.lot === null && h.ref === g.ref && h.kind === g.kind))
    .map((g) => (g.kind === 'insurance' && afterAward ? { ...g, remediable: true } : g));
  return { ...o, lots, gates };
}
