import { z } from 'zod';
import { chatJSON, type StepLogger } from '@pactovio/models';
import type { CompanyProfile, Tender } from '@pactovio/contracts';
import type { ModelEnv } from '@pactovio/contracts/env';

export const TriageResult = z.object({
  fit_score: z.number().min(0).max(100),
  reason: z.string(),
  door: z.enum(['tender', 'rfp', 'design']),
});
export type TriageResult = z.infer<typeof TriageResult>;

export interface TriageWorkspace {
  id: string;
  name: string;
  segment: 'it' | 'industrial';
  profile: Partial<CompanyProfile>;
}

export type TriageFn = (ws: TriageWorkspace, tender: Tender) => Promise<TriageResult>;

const list = (xs: string[] | undefined, n = 8) => (xs ?? []).slice(0, n).join('; ') || 'none listed';

export function companySummary(ws: TriageWorkspace): string {
  const p = ws.profile;
  return [
    `Company: ${p.legal_name ?? ws.name}, ${p.hq?.city ?? ''} ${p.hq?.country ?? ''}, ${p.staff?.total ?? '?'} staff.`,
    `Services: ${list(p.services)}.`,
    `Capabilities: ${list(p.capabilities)}.`,
    `Certifications: ${list(p.certifications?.map((c) => c.name))}.`,
    `Regions: ${list(p.regions)}. CPV focus: ${list(p.cpv_focus, 10)}. Keywords: ${list(p.keywords)}.`,
  ].join('\n');
}

export function tenderSummary(t: Tender): string {
  const lots = t.lots.slice(0, 6).map((l) => `Lot ${l.lot_no}: ${l.title}`).join(' | ');
  const desc = typeof t.raw?.description === 'string' ? t.raw.description.slice(0, 700) : '';
  return [
    `Title: ${t.title}`,
    `Buyer: ${t.buyer} (${t.country})`,
    `CPV: ${t.cpv.slice(0, 8).join(', ')}`,
    `Estimated value: ${t.value_eur === null ? 'not stated' : `EUR ${t.value_eur}`}. Deadline: ${t.deadline ?? 'not stated'}.`,
    lots ? `Lots: ${lots}` : '',
    desc ? `Description: ${desc}` : '',
  ].filter(Boolean).join('\n');
}

/** Lightning (MODEL_FAST, thinking off, flex tier, concurrency cap 4 inside `chat`) scores one notice against one company. */
export function lightningTriage(env: ModelEnv, onStep?: StepLogger, fetchFn?: typeof fetch): TriageFn {
  return async (ws, tender) => {
    const { data } = await chatJSON(TriageResult, {
      env,
      role: 'fast',
      flex: true,
      purpose: `triage ${tender.source_ref} for ${ws.id}`,
      maxTokens: 300,
      temperature: 0,
      onStep,
      fetch: fetchFn,
      schemaName: 'tender_triage',
      messages: [
        {
          role: 'system',
          content:
            'You triage public procurement notices for a supplier. Score how well the notice fits the company: 0-100 where 80+ means the company clearly can and should bid, 50-79 a plausible bid needing checks, below 50 a poor fit (wrong scope, size or region). Reason in one or two plain sentences naming the decisive facts. door is "tender" for public notices. Return only JSON {"fit_score","reason","door"}.',
        },
        { role: 'user', content: `${companySummary(ws)}\n\n--- Notice ---\n${tenderSummary(tender)}` },
      ],
    });
    return data;
  };
}
