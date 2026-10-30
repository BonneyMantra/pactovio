import { z } from 'zod';
import { Iso, Json, Minor, Segment } from './common';

export const Certification = z.object({
  name: z.string(),
  scope: z.string().optional(),
  issuer: z.string().optional(),
  valid_from: z.string().optional(),
  valid_to: z.string().nullable().optional(),
  evidence_id: z.string().optional(),
});

export const ClientReference = z.object({
  client: z.string(),
  title: z.string(),
  sector: z.string().optional(),
  year: z.number().int().optional(),
  value_minor: Minor.optional(),
  currency: z.string().default('EUR'),
  summary: z.string(),
});

/** workspaces.profile_json: what the engine knows about the supplier. */
export const CompanyProfile = z.object({
  legal_name: z.string(),
  sample_label: z.string().optional(),
  tagline: z.string().optional(),
  hq: z.object({ city: z.string(), country: z.string() }),
  sites: z.array(z.object({ city: z.string(), country: z.string(), role: z.string() })).default([]),
  founded: z.number().int().optional(),
  staff: z.object({ total: z.number().int(), by_role: z.record(z.string(), z.number().int()).default({}) }),
  turnover: z.array(z.object({ year: z.number().int(), amount_minor: Minor, currency: z.string() })).default([]),
  services: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
  certifications: z.array(Certification).default([]),
  references: z.array(ClientReference).default([]),
  insurance: z
    .object({
      currency: z.string(),
      public_liability_minor: Minor,
      professional_indemnity_minor: Minor,
      employers_liability_minor: Minor.optional(),
      cyber_minor: Minor.optional(),
    })
    .optional(),
  regions: z.array(z.string()).default([]),
  cpv_focus: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  extra: Json.optional(),
});
export type CompanyProfile = z.infer<typeof CompanyProfile>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  segment: Segment,
  profile: CompanyProfile,
  sample: z.boolean(),
  created_at: Iso,
});
export type Workspace = z.infer<typeof Workspace>;

export const JudgeSession = z.object({
  id: z.string(),
  workspace_id: z.string(),
  created_at: Iso,
  runs_used: z.number().int(),
  tavily_used: z.number().int(),
});
export type JudgeSession = z.infer<typeof JudgeSession>;
