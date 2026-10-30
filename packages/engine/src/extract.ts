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
- gates: every PASS/FAIL selection criterion (financial standing / turnover, tax compliance, insurance levels per cover type, health and safety, professional ability, certifications such as ISO 27001, number of references, exclusion grounds). One item per distinct criterion; lot = null when it applies to all lots. Lift numbers exactly (turnover in whole euros and over how many years, cover limits in whole euros, number of references and look-back years).
- deadlines: submission deadline, clarification query deadline, any other dated milestone (ISO 8601; times are Irish local = GMT/UTC unless the pack says otherwise).
- submission_deadline: the closing date/time for tender responses.
- clarifications: every numbered clarification with the query, the buyer response, and what it affects.
- forms: every document the tenderer must complete and return.`;
  return chatJSON(Overview, {
    env: c.env, role: 'reason', purpose: 'Whole-pack overview: lots, gates, deadlines, clarifications', schemaName: 'overview',
    messages: messages(c.pack, task), maxTokens: 14000, timeoutMs: 600_000, onStep: c.onStep, fetch: c.fetch, extra: NO_THINK,
  });
}

export async function extractLot(c: Common, lot: { lot_no: string; title: string; response_form_doc: string | null }) {
  const form = lot.response_form_doc ? `Its response form is "${lot.response_form_doc}".` : '';
  const task = `Extract EVERY requirement for LOT ${lot.lot_no} (${lot.title}). ${form}
Sources: the Requirements and Specifications document, the lot's response form tables (Ref No., Requirements, Mandatory/Desirable, compliance, comments), and the award criteria in the call for tender.
- kind: "mandatory" = must / M / pass-fail; "scored" = weighted award criterion or desirable (D) item that earns marks or a written method statement that is scored; "info" = context the tenderer need not answer.
- weight: percentage of the award marks the criterion carries when stated, else null.
- needs_response: true when the response form has a box where the tenderer must write an answer for this item.
- word_limit: only when stated for that item.
- Skip the selection gates (turnover, insurance, tax, exclusion), they are handled separately, and skip requirements that belong to other lots.
- Apply clarifications that change a requirement and cite them in note.
Return every item, one entry per reference number, no summarising.`;
  return chatJSON(LotRequirements, {
    env: c.env, role: 'reason', purpose: `Whole-pack extraction: Lot ${lot.lot_no} requirements`, schemaName: 'lot_requirements',
    messages: messages(c.pack, task), maxTokens: 30000, timeoutMs: 900_000, onStep: c.onStep, fetch: c.fetch, extra: NO_THINK,
  });
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
