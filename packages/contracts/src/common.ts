import { z } from 'zod';

/** ISO 8601 timestamp string (UTC). */
export const Iso = z.string();
/** Integer minor units (cents/pence). Never a float. */
export const Minor = z.number().int();
export const Json = z.record(z.string(), z.unknown());

export const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const Segment = z.enum(['it', 'industrial']);
export const TenderSource = z.enum(['ted', 'etenders', 'fts', 'upload']);
export const Door = z.enum(['tender', 'rfp', 'design']);
export const IntakeSource = z.enum(['scan', 'upload', 'gmail', 'outlook', 'api', 'chat', 'mcp']);
export const IntakeStatus = z.enum(['new', 'classified', 'processing', 'ready', 'ignored']);
export const DocKind = z.enum(['pdf', 'docx', 'xlsx', 'image', 'zip', 'email']);
export const ReqKind = z.enum(['mandatory', 'scored', 'info']);
export const ReqStatus = z.enum(['MET', 'PARTIAL', 'GAP', 'NEEDS_EVIDENCE']);
export const Decision = z.enum(['BID', 'NO_BID', 'CONDITIONAL']);
export const MatchStatus = z.enum(['new', 'shortlisted', 'dismissed', 'bidding']);
export const RunStatus = z.enum(['queued', 'running', 'completed', 'failed']);
export const StepStatus = z.enum(['running', 'ok', 'error']);
export const AnswerStatus = z.enum(['draft', 'approved']);
export const AuditStatus = z.enum(['queued', 'running', 'completed', 'failed']);
export const ConnectorStatus = z.enum(['available', 'pending', 'connected', 'error']);
export const QuoteStatus = z.enum(['draft', 'ready', 'sent', 'accepted', 'expired']);
export const DesignStatus = z.enum(['new', 'matched', 'quoted', 'closed']);
export const PlanId = z.enum(['free', 'pro', 'max']);

export const EventType = z.enum([
  'tender.matched',
  'intake.received',
  'intake.classified',
  'run.started',
  'run.step',
  'run.completed',
  'verdict.ready',
  'answer.drafted',
  'approval.requested',
  'audit.completed',
  'quote.ready',
  'certificate.expiring',
  'billing.updated',
]);
export type EventType = z.infer<typeof EventType>;

/** Pagination used by list endpoints. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export type Segment = z.infer<typeof Segment>;
export type TenderSource = z.infer<typeof TenderSource>;
export type Door = z.infer<typeof Door>;
export type IntakeSource = z.infer<typeof IntakeSource>;
export type IntakeStatus = z.infer<typeof IntakeStatus>;
export type DocKind = z.infer<typeof DocKind>;
export type ReqKind = z.infer<typeof ReqKind>;
export type ReqStatus = z.infer<typeof ReqStatus>;
export type Decision = z.infer<typeof Decision>;
export type MatchStatus = z.infer<typeof MatchStatus>;
export type RunStatus = z.infer<typeof RunStatus>;
export type PlanId = z.infer<typeof PlanId>;
