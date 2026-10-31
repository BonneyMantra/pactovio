import { z } from 'zod';
import { chatJSON, type StepLogger, isBudgetError } from '@pactovio/models';
import type { Env } from '@pactovio/contracts/env';

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  attachments: { filename: string; r2Key: string }[];
  receivedAt: string;
  to?: string;
  threadId?: string;
  provider?: 'gmail' | 'outlook';
}

export const Classification = z.object({
  door: z.enum(['tender', 'rfp', 'design', 'other']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  /** Buyer or customer organisation, if the message names one. */
  customer: z.string(),
  /** A clean one-line subject for the intake. */
  subject: z.string(),
});
export type Classification = z.infer<typeof Classification>;

const SYSTEM = `You triage the shared inbox of a technical B2B supplier. Classify ONE inbound email into exactly one door:
- "tender": a public procurement notice or a pointer to one (TED, eTenders, buyer portal, "invitation to tender", CPV codes, a formal call for competition).
- "rfp": a private buyer's request for proposal, quotation or information (RFP, RFQ, RFI), usually with a document pack or a questionnaire to complete and a deadline.
- "design": a customer asking the supplier to design, specify or quote a product or system to a technical requirement (sensors, protocols, interfaces, capacity), without a formal procurement pack.
- "other": everything else (newsletters, invoices, meeting chatter, spam, replies to earlier threads, marketing).
Reply with JSON only: door, confidence (0 to 1), reason (one short sentence), customer (organisation name or empty string), subject (a clean one-line title).`;

const FALLBACK: [RegExp, Classification['door']][] = [
  [/\b(invitation to tender|ted\.europa|etenders|call for competition|cpv)\b/i, 'tender'],
  [/\b(rfp|rfq|rfi|request for (proposal|quotation|quote|information)|questionnaire|tender)\b/i, 'rfp'],
  [/\b(design|specification|spec(ify)?|monitoring|sensor|modbus|rs-?485|4g|quote for|can you (supply|provide))\b/i, 'design'],
];

/** Keyword fallback used only when the model call fails; confidence is deliberately low. */
export function heuristicClassify(msg: InboundMessage): Classification {
  const text = `${msg.subject}\n${msg.body.slice(0, 3000)}`;
  const hit = FALLBACK.find(([re]) => re.test(text));
  return { door: hit?.[1] ?? 'other', confidence: hit ? 0.4 : 0.6, reason: 'Keyword fallback: the classifier model was unavailable.', customer: '', subject: msg.subject.slice(0, 160) };
}

/** Lane: connectors. Classify an inbound email into a door (MODEL_FAST, thinking off, json_schema). */
export async function classifyEmail(env: Env, msg: InboundMessage, opts: { onStep?: StepLogger; fetch?: typeof fetch } = {}): Promise<Classification> {
  const attachments = msg.attachments.map((a) => a.filename).join(', ') || 'none';
  const user = `From: ${msg.from}\nSubject: ${msg.subject}\nAttachments: ${attachments}\n\n${msg.body.slice(0, 6000)}`;
  try {
    const { data } = await chatJSON(Classification, {
      env, role: 'fast', purpose: 'classify inbound email', maxTokens: 400, temperature: 0, schemaName: 'email_classification',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], onStep: opts.onStep, fetch: opts.fetch,
    });
    return data;
  } catch (e) {
    if (isBudgetError(e)) throw e; // daily cap or kill switch: no keyword guess in place of the model
    console.error('classifyEmail failed', e instanceof Error ? e.message : 'unknown');
    return heuristicClassify(msg);
  }
}
