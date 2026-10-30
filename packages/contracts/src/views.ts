import { z } from 'zod';
import { Iso, Json, PlanId } from './common';
import { Workspace } from './entities-company';
import {
  Document, Intake, Requirement, Run, RunStep, Tender, TenderMatch, Verdict,
} from './entities-tender';

export const Health = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  time: Iso,
  bindings: z.record(z.string(), z.boolean()),
});

export const SessionInfo = z.object({
  session_id: z.string(),
  workspace_id: z.string(),
  workspace: Workspace,
  caps: z.object({ runs: z.number().int(), tavily: z.number().int(), agent_turns_per_min: z.number().int() }),
  runs_used: z.number().int(),
  tavily_used: z.number().int(),
});

export const TenderWithMatch = z.object({ tender: Tender, match: TenderMatch.nullable() });
export const TenderList = z.object({ items: z.array(TenderWithMatch), total: z.number().int(), next_cursor: z.string().nullable() });

export const TodayFeed = z.object({
  workspace_id: z.string(),
  generated_at: Iso,
  counts: z.object({
    new_matches: z.number().int(),
    open_intakes: z.number().int(),
    approvals_pending: z.number().int(),
    expiring_certificates: z.number().int(),
    runs_today: z.number().int(),
  }),
  top_matches: z.array(TenderWithMatch),
  closing_soon: z.array(z.object({ tender_id: z.string(), title: z.string(), buyer: z.string(), deadline: Iso, days_left: z.number() })),
  intakes: z.array(Intake),
  approvals: z.array(z.object({ answer_id: z.string(), tender_id: z.string(), question_ref: z.string(), tender_title: z.string() })),
  expiring: z.array(z.object({ evidence_id: z.string(), title: z.string(), valid_to: z.string(), days_left: z.number() })),
  recent_runs: z.array(Run),
});

export const TenderDetail = z.object({
  tender: Tender,
  match: TenderMatch.nullable(),
  documents: z.array(Document),
  latest_run: Run.nullable(),
  verdicts: z.array(Verdict),
  requirement_counts: z.object({
    total: z.number().int(),
    MET: z.number().int(), PARTIAL: z.number().int(), GAP: z.number().int(), NEEDS_EVIDENCE: z.number().int(),
  }),
});

export const Matrix = z.object({
  tender_id: z.string(),
  lots: z.array(z.string()),
  requirements: z.array(Requirement),
  verdicts: z.array(Verdict),
});

export const StartRunBody = z.object({ replay: z.boolean().optional() });
export const StartRunResult = z.object({ run_id: z.string() });

export const RunDetail = z.object({ run: Run, steps: z.array(RunStep) });

export const DraftAnswerBody = z.object({
  lot: z.string().optional(),
  question_ref: z.string(),
  question: z.string(),
  word_limit: z.number().int().optional(),
});
export const PatchAnswerBody = z.object({
  draft: z.string().optional(),
  status: z.enum(['draft', 'approved']).optional(),
});
export const FillFormBody = z.object({ answer_ids: z.array(z.string()).optional() });
export const FillFormResult = z.object({ r2_key: z.string(), download_url: z.string() });

export const RefreshBuyerResult = z.object({ buyer_key: z.string(), refreshed: z.boolean(), tavily_used: z.number().int() });

export const EvidenceUploadResult = z.object({ evidence_id: z.string(), status: z.enum(['queued', 'ready']) });
export const IntakeCreateBody = z.object({
  title: z.string().optional(),
  sender: z.string().optional(),
  text: z.string().optional(),
  door: z.enum(['tender', 'rfp', 'design']).optional(),
});
export const IntakeCreateResult = z.object({ intake_id: z.string(), status: z.string() });
export const IntakeDetail = z.object({ intake: Intake, documents: z.array(Document) });

export const QuoteFromDesignBody = z.object({ product_ids: z.array(z.string()).optional(), qty: z.number().int().optional() });
export const ExportQuoteQuery = z.object({ format: z.enum(['docx', 'xlsx']).default('docx') });

export const ConnectBody = z.object({ redirect_to: z.string().optional() });
export const ConnectResult = z.object({ redirect_url: z.string() });
export const TestActionBody = z.object({ action: z.string(), input: Json.optional() });
export const TestActionResult = z.object({ ok: z.boolean(), output: z.unknown().optional() });

export const WebhookCreateBody = z.object({ url: z.url(), events: z.array(z.string()).min(1) });
export const WebhookCreateResult = z.object({ id: z.string(), url: z.string(), events: z.array(z.string()), secret: z.string() });
export const ApiKeyCreateBody = z.object({ name: z.string().min(1).max(80) });
export const ApiKeyCreateResult = z.object({ id: z.string(), prefix: z.string(), name: z.string(), key: z.string() });
export const IcsInfo = z.object({ url: z.string(), token: z.string() });

export const AgentThread = z.object({ id: z.string(), title: z.string(), created_at: Iso, updated_at: Iso });
export const PendingAction = z.object({
  id: z.string(), tool: z.string(), input: Json, summary: z.string(),
  status: z.enum(['pending', 'confirmed', 'declined', 'executed', 'failed']),
});
export const AgentMessage = z.object({
  id: z.string(),
  thread_id: z.string(),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  tool_calls: z.array(z.object({ name: z.string(), input: Json, output: z.unknown().optional() })).optional(),
  pending_action: PendingAction.optional(),
  at: Iso,
});
export const AgentMessageBody = z.object({ content: z.string().min(1).max(8000) });
export const AgentWsMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), thread_id: z.string(), content: z.string() }),
  z.object({ type: z.literal('assistant_delta'), thread_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal('assistant_message'), message: AgentMessage }),
  z.object({ type: z.literal('approval_requested'), action: PendingAction }),
  z.object({ type: z.literal('event'), event_type: z.string(), payload: Json }),
  z.object({ type: z.literal('error'), error: z.string(), code: z.string().optional() }),
]);
export type AgentWsMessage = z.infer<typeof AgentWsMessage>;

export const PlanInfo = z.object({
  id: PlanId, name: z.string(), price_minor: z.number().int(), currency: z.string(),
  monthly_credits: z.number().int(), features: z.array(z.string()),
});
export const BillingState = z.object({
  workspace_id: z.string(),
  plan: PlanId,
  status: z.string(),
  current_period_end: Iso.nullable(),
  credits_balance: z.number().int(),
  plans: z.array(PlanInfo),
});
export const CheckoutBody = z.object({ plan: z.enum(['pro', 'max']) });
export const UrlResult = z.object({ url: z.string() });

export const Limits = z.object({
  session: z.object({
    runs_used: z.number().int(), runs_cap: z.number().int(),
    tavily_used: z.number().int(), tavily_cap: z.number().int(),
    agent_turns_per_min_cap: z.number().int(),
  }),
  inference: z.object({ rpm: z.number().int(), tpm: z.number().int(), global_concurrency: z.number().int(), shared_across_products: z.number().int() }),
  note: z.string(),
});

export const EventsQuery = z.object({ since: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() });

export const AuditResultBody = z.object({
  audit_id: z.string(),
  status: z.enum(['completed', 'failed']),
  job_id: z.string().optional(),
  result: Json.optional(),
});
