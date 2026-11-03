import { z } from 'zod';
import { CompanyInput, CustomerSettings, HttpError, OnboardingGoal, PersonInput, SetupStage } from '@pactovio/contracts';
import { missingCompanyFields } from './company-required';

const List = z.array(z.string()).catch([]);
const Profile = z.object({
  description: z.string().optional().catch(undefined),
  offerings: List.optional(), customers: List.optional(), markets: List.optional(),
  sources: z.array(z.object({ url: z.string(), title: z.string() })).optional().catch([]),
  confirmed_at: z.string().nullable().optional().catch(null),
}).catch({});
const Setup = z.object({ stage: SetupStage.catch('about').default('about'), completed_at: z.string().nullable().catch(null).default(null) }).catch({ stage: 'about', completed_at: null });

/** v2 rows may hold keyword-labelled opportunity summaries; v3 never outputs a keyword fit, so they read as unassessed. */
function legacyFree(results: Record<string, unknown>): Record<string, unknown> {
  const opp = results.opportunities as { top?: unknown } | undefined;
  if (!opp || !Array.isArray(opp.top)) return results;
  const top = opp.top.map((n) => {
    const fit = (n as { fit?: { method?: string } })?.fit;
    return fit?.method === 'keyword' ? { ...(n as object), fit: { method: 'unassessed', reasons: [], strengths: [], risks: [] } } : n;
  });
  return { ...results, opportunities: { ...opp, top } };
}

type Row = { data_json: string; settings_json: string; completed_at: string | null; updated_at: string };

/** Parse stored onboarding data. v1 fields keep their exact shape; v2 fields are tolerant so old rows never break reads. */
export function shapeOnboarding(row: Row) {
  const data = JSON.parse(row.data_json) as Record<string, unknown>;
  const profile = Profile.parse(data.profile ?? {});
  const setup = Setup.parse(data.setup ?? {});
  const company = CompanyInput.partial().parse(data), shapedProfile = { ...profile, confirmed_at: profile.confirmed_at ?? null };
  return {
    company,
    settings: CustomerSettings.partial().parse(JSON.parse(row.settings_json)),
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    person: PersonInput.catch({}).parse(data.person ?? {}),
    profile: shapedProfile,
    /** v3: mandatory company fields still missing (the UI shows them in #/setup; completed users are not gated). */
    required_missing: missingCompanyFields({ company, profile: shapedProfile }),
    goals: z.array(OnboardingGoal).catch([]).parse(data.goals ?? []),
    setup: { version: 2 as const, stage: setup.stage, completed_at: setup.completed_at },
    results: legacyFree(z.record(z.string(), z.unknown()).catch({}).parse(data.results ?? {})),
    website_analysis: (data.website_analysis ?? null) as Record<string, unknown> | null,
  };
}
export type OnboardingState = ReturnType<typeof shapeOnboarding>;

export async function readOnboarding(db: D1Database, workspace: string): Promise<OnboardingState> {
  const row = await db.prepare('SELECT * FROM company_onboarding WHERE workspace_id = ?').bind(workspace).first<Row>();
  if (!row) throw new HttpError(404, 'Company setup not found', 'not_found');
  return shapeOnboarding(row);
}

/** RFC 7396 merge into data_json (atomic in SQLite, so concurrent tabs do not lose each other's fields). */
export async function patchData(db: D1Database, workspace: string, patch: Record<string, unknown>): Promise<void> {
  await db.prepare('UPDATE company_onboarding SET data_json = json_patch(data_json, ?), updated_at = ? WHERE workspace_id = ?')
    .bind(JSON.stringify(patch), new Date().toISOString(), workspace).run();
}

/** Results written by the server-side steps live under data_json.results.<goal>. */
export const saveResult = (db: D1Database, workspace: string, goal: string, value: Record<string, unknown>) =>
  patchData(db, workspace, { results: { [goal]: { ...value, at: new Date().toISOString() } } });
