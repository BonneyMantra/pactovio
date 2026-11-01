import { z } from 'zod';

export const CustomerEmail = z.string().trim().toLowerCase().max(254).email();
export const RequestCode = z.object({ email: CustomerEmail }).strict();
export const VerifyCode = RequestCode.extend({ code: z.string().regex(/^\d{6}$/) });
export const CodeRequested = z.object({ ok: z.literal(true), retry_after: z.literal(60), expires_in: z.literal(600) });
export const CompanyInput = z.object({
  name: z.string().trim().min(2).max(160),
  website: z.union([z.literal(''), z.url().max(2048).refine((v) => /^https?:\/\//i.test(v), 'Use an http or https URL')]).optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((v) => v.toUpperCase()),
  supplier_segment: z.enum(['it', 'industrial']),
  capabilities: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
});
export const CustomerSettings = z.object({
  timezone: z.string().max(80).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  notifications_enabled: z.boolean(),
});
export const OnboardingPatch = z.object({
  company: CompanyInput.partial().strict().optional(),
  settings: CustomerSettings.partial().strict().optional(),
}).strict();
export const OnboardingInfo = z.object({
  company: CompanyInput.partial(), settings: CustomerSettings.partial(), completed_at: z.string().nullable(), updated_at: z.string(),
});
export const CustomerIdentity = z.object({ id: z.string(), email: CustomerEmail });
