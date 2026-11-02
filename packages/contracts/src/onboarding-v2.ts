import { z } from 'zod';

/** Onboarding v2 boundaries. Stored in company_onboarding.data_json beside the v1 company fields. */
const Text = (max: number) => z.string().trim().min(1).max(max);
const HttpUrl = z.url().max(2048).refine((v) => /^https?:\/\//i.test(v), 'Use an http or https URL');
const realDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
export const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, 'Use a real calendar date (YYYY-MM-DD)');

export const OnboardingGoal = z.enum(['opportunities', 'organize', 'quotes', 'deadlines']);
export const SetupStage = z.enum(['about', 'company', 'goals', 'result', 'connect', 'ready']);
export const PersonInput = z.object({ full_name: Text(120), job_title: Text(120) }).partial().strict();
export const ProfileSource = z.object({ url: HttpUrl, title: z.string().trim().max(200) }).strict();
export const ProfileInput = z.object({
  description: z.string().trim().max(2000),
  offerings: z.array(Text(160)).max(50),
  customers: z.array(Text(160)).max(50),
  markets: z.array(Text(160)).max(50),
  sources: z.array(ProfileSource).max(10),
  /** Any string or true-ish value is replaced by the server's own timestamp; null clears confirmation. */
  confirmed_at: z.string().max(40).nullable(),
}).partial().strict();
/** setup.completed_at is written only by POST /api/onboarding/setup/complete. */
export const SetupPatch = z.object({ version: z.literal(2), stage: SetupStage }).partial().strict();
/** Organize result is recorded by the UI; the server recounts products itself and stamps the time. */
export const OrganizeResultInput = z.object({
  source: z.string().trim().max(64).optional(),
  import_job_id: z.string().trim().max(80).optional(),
});
export const ResultsPatch = z.object({ organize: OrganizeResultInput }).strict();
export const OnboardingGoals = z.array(OnboardingGoal).max(4).transform((v) => [...new Set(v)]);

export const WebsiteAnalyzeInput = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
export const DeadlineExtractInput = z.object({ text: z.string().min(1).max(40000), title: z.string().trim().max(200).default('') }).strict();
export const DeadlineItemInput = z.object({ title: Text(200), due_at: IsoDay, excerpt: z.string().trim().max(600).default('') }).strict();
export const DeadlinesSaveInput = z.object({
  items: z.array(DeadlineItemInput).min(1).max(50),
  source_title: z.string().trim().max(200).default(''),
}).strict();
export const QuoteDraftInput = z.object({ request_text: z.string().trim().min(1).max(20000), title: z.string().trim().max(200).default('') }).strict();
export const QuoteCreateInput = z.object({
  request_text: z.string().trim().min(1).max(20000),
  title: z.string().trim().max(200).default(''),
  customer: z.string().trim().max(160).optional(),
  lines: z.array(z.object({ product_id: z.string().min(1).max(80), qty: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(50)
    .refine((l) => new Set(l.map((x) => x.product_id)).size === l.length, 'Each product can appear once'),
}).strict();

export const AiState = z.object({ ran: z.boolean(), code: z.enum(['models_disabled', 'budget', 'auth_rejected', 'unavailable']).optional() });
export type AiState = z.infer<typeof AiState>;
