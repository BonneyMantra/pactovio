import { z } from 'zod';
import {
  AnswerStatus, AuditStatus, Decision, Door, DocKind, Iso, Json, MatchStatus, ReqKind, ReqStatus,
  RunStatus, StepStatus, TenderSource, IntakeSource, IntakeStatus,
} from './common';

export const Lot = z.object({
  lot_no: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** Whole euros (TED style). */
  value_eur: z.number().int().nullable().optional(),
  cpv: z.array(z.string()).optional(),
});

/** value_eur is WHOLE EUROS (the one exception to minor units: it mirrors TED's own field). */
export const Tender = z.object({
  id: z.string(),
  source: TenderSource,
  source_ref: z.string(),
  title: z.string(),
  buyer: z.string(),
  buyer_key: z.string(),
  country: z.string(),
  cpv: z.array(z.string()),
  value_eur: z.number().int().nullable(),
  deadline: Iso.nullable(),
  url: z.string().nullable(),
  lots: z.array(Lot),
  published_at: Iso.nullable(),
  raw: Json.nullable(),
});
export type Tender = z.infer<typeof Tender>;

export const TenderMatch = z.object({
  workspace_id: z.string(),
  tender_id: z.string(),
  fit_score: z.number().min(0).max(100),
  fit_reason: z.string(),
  status: MatchStatus,
  created_at: Iso,
});
export type TenderMatch = z.infer<typeof TenderMatch>;

export const Document = z.object({
  id: z.string(),
  tender_id: z.string().nullable(),
  intake_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  filename: z.string(),
  kind: DocKind,
  r2_key: z.string(),
  pages: z.number().int().nullable(),
  text_r2_key: z.string().nullable(),
  is_form: z.boolean(),
});
export type Document = z.infer<typeof Document>;

export const Intake = z.object({
  id: z.string(),
  workspace_id: z.string(),
  door: Door,
  source: IntakeSource,
  title: z.string(),
  sender: z.string().nullable(),
  received_at: Iso,
  status: IntakeStatus,
  classification: z.object({ door: Door, confidence: z.number(), reason: z.string() }).nullable(),
  tender_id: z.string().nullable(),
  design_request_id: z.string().nullable(),
});
export type Intake = z.infer<typeof Intake>;

export const Run = z.object({
  id: z.string(),
  workspace_id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  kind: z.string(),
  status: RunStatus,
  started_at: Iso,
  finished_at: Iso.nullable(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: z.number(),
  replay: z.boolean(),
});
export type Run = z.infer<typeof Run>;

export const RunStep = z.object({
  id: z.string(),
  run_id: z.string(),
  seq: z.number().int(),
  at: Iso,
  purpose: z.string(),
  model: z.string().nullable(),
  status: StepStatus,
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  tokens_cached: z.number().int(),
  ms: z.number().int(),
  cost_usd: z.number(),
  summary: z.string().nullable(),
});
export type RunStep = z.infer<typeof RunStep>;

export const Requirement = z.object({
  id: z.string(),
  workspace_id: z.string(),
  tender_id: z.string(),
  lot: z.string().nullable(),
  ref: z.string(),
  text: z.string(),
  kind: ReqKind,
  weight: z.number().nullable(),
  doc_id: z.string().nullable(),
  page: z.number().int().nullable(),
  status: ReqStatus,
  evidence_ids: z.array(z.string()),
  note: z.string().nullable(),
});
export type Requirement = z.infer<typeof Requirement>;

export const Verdict = z.object({
  id: z.string(),
  workspace_id: z.string(),
  tender_id: z.string(),
  lot: z.string().nullable(),
  decision: Decision,
  score: z.number(),
  gates: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
  reasons: z.array(z.string()),
  run_id: z.string().nullable(),
});
export type Verdict = z.infer<typeof Verdict>;

export const Claim = z.object({
  text: z.string(),
  evidence_ids: z.array(z.string()),
  supported: z.boolean(),
});

export const Answer = z.object({
  id: z.string(),
  workspace_id: z.string(),
  tender_id: z.string(),
  lot: z.string().nullable(),
  question_ref: z.string(),
  question: z.string(),
  word_limit: z.number().int().nullable(),
  draft: z.string(),
  claims: z.array(Claim),
  status: AnswerStatus,
  approved_at: Iso.nullable(),
});
export type Answer = z.infer<typeof Answer>;

export const Audit = z.object({
  id: z.string(),
  workspace_id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  job_id: z.string().nullable(),
  status: AuditStatus,
  result: Json.nullable(),
  created_at: Iso,
  completed_at: Iso.nullable(),
});
export type Audit = z.infer<typeof Audit>;

export const BuyerIntel = z.object({
  buyer_key: z.string(),
  summary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string(), source_idx: z.number().int().optional() })),
  sources: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string().optional() })),
  fetched_at: Iso,
});
export type BuyerIntel = z.infer<typeof BuyerIntel>;
