import { z } from 'zod';

export const GateKind = z.enum(['turnover', 'insurance', 'certification', 'references', 'exclusion', 'other']);
export const InsuranceType = z.enum(['public_liability', 'professional_indemnity', 'employers_liability', 'cyber']);

/** A pass/fail selection criterion. The model lifts the numbers out of the text; code evaluates them. */
export const GateSpec = z.object({
  lot: z.string().nullable().describe('Lot number this gate applies to, null when it applies to every lot'),
  ref: z.string().describe('Reference as printed, e.g. A2'),
  kind: GateKind,
  text: z.string().describe('The requirement, quoted or tightly paraphrased'),
  min_turnover_eur: z.number().nullable().describe('Minimum turnover in whole euros, else null'),
  turnover_basis: z.enum(['average', 'each_year']).nullable(),
  years: z.number().int().nullable().describe('Number of years the turnover or references are measured over'),
  insurance_type: InsuranceType.nullable(),
  min_cover_eur: z.number().nullable().describe('Minimum insurance cover in whole euros'),
  certification: z.string().nullable().describe('Certification required, e.g. ISO 27001'),
  min_references: z.number().int().nullable(),
  remediable: z.boolean().describe('True when the pack lets the tenderer meet it only if successful or after award ("holds, or will hold should they be successful", "before contract"), so a shortfall can still be fixed'),
  doc: z.string().describe('Exact filename of the document the gate comes from'),
  page: z.number().int().nullable(),
});
export type GateSpec = z.infer<typeof GateSpec>;

export const Overview = z.object({
  title: z.string(),
  buyer: z.string(),
  procedure: z.string().nullable(),
  submission_deadline: z.string().nullable().describe('ISO 8601 with offset, e.g. 2026-11-19T14:00:00+00:00'),
  lots: z.array(z.object({ lot_no: z.string().describe('The lot number only, e.g. "1"'), title: z.string(), value_eur: z.number().nullable(), response_form_doc: z.string().nullable() })),
  gates: z.array(GateSpec),
  deadlines: z.array(z.object({ label: z.string(), at: z.string().describe('ISO 8601 date or datetime'), doc: z.string(), page: z.number().int().nullable() })),
  clarifications: z.array(z.object({ no: z.string(), query: z.string(), response: z.string(), affects: z.string().nullable().describe('Requirement refs or topic changed by the response') })),
  forms: z.array(z.object({ doc: z.string(), lot: z.string().nullable(), purpose: z.string() })),
});
export type Overview = z.infer<typeof Overview>;

export const ExtractedReq = z.object({
  ref: z.string().describe('Reference exactly as printed, e.g. B1.1.1'),
  text: z.string().describe('The requirement text, as written (after any clarification override)'),
  kind: z.enum(['mandatory', 'scored', 'info']).describe('mandatory = must/M/pass-fail; scored = weighted award criterion or desirable item; info = headings, form-completion instructions, background'),
  weight: z.number().nullable().describe('Percentage of the award marks this criterion carries, else null'),
  word_limit: z.number().int().nullable(),
  needs_response: z.boolean().describe('True ONLY when the tenderer writes a narrative answer in a free-text box. False for price and cost tables, rate cards, yes/no confirmations, CV and staff tables, signatures'),
  doc: z.string().describe('Exact filename where the requirement is printed'),
  page: z.number().int().nullable().describe('Page number from the [page N] marker'),
  note: z.string().nullable().describe('Clarification that overrides or refines the requirement, e.g. "Clarification 3: ..."'),
});
export type ExtractedReq = z.infer<typeof ExtractedReq>;
export const LotRequirements = z.object({
  requirements: z.array(ExtractedReq).max(60),
  has_more: z.boolean().describe('True when more requirements of this lot remain after the last one returned'),
});

export const Coverage = z.enum(['covers', 'partial', 'contradicts', 'none']);
export type Coverage = z.infer<typeof Coverage>;
export const JudgeBatch = z.object({
  judgements: z.array(z.object({ idx: z.number().int(), coverage: Coverage, evidence_ids: z.array(z.string()), note: z.string() })),
});

export const VerdictReasons = z.object({ reasons: z.array(z.string()).min(1).max(6) });

export const EvidenceRecord = z.object({
  title: z.string(),
  issuer: z.string().nullable(),
  scope: z.string().nullable(),
  valid_to: z.string().nullable().describe('Expiry date as YYYY-MM-DD, null if none shown'),
  kind: z.enum(['certificate', 'insurance', 'financial', 'case_study', 'policy', 'cv', 'other']),
  summary: z.string().describe('Two or three plain sentences with every figure printed on the document'),
  transcript: z.string().describe('Key text of the document, verbatim, up to 1500 characters'),
});
