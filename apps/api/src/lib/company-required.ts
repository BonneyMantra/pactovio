import type { z } from 'zod';
import { CompanyInput, HttpError } from '@pactovio/contracts';

/** Every company-understanding value is mandatory before the profile is confirmed or setup completes (v3). */
export const REQUIRED_COMPANY_FIELDS = ['name', 'country', 'supplier_segment', 'capabilities', 'description', 'offerings', 'markets', 'customers'] as const;
export type RequiredCompanyField = typeof REQUIRED_COMPANY_FIELDS[number];

type Shape = {
  company: Partial<z.output<typeof CompanyInput>>;
  profile: { description?: string; offerings?: string[]; customers?: string[]; markets?: string[] };
};
const filled = (xs: unknown) => Array.isArray(xs) && xs.some((x) => typeof x === 'string' && x.trim().length > 0);

/** Names of the mandatory fields that are missing or invalid, in display order. */
export function missingCompanyFields(s: Shape): RequiredCompanyField[] {
  const company = CompanyInput.partial().safeParse(s.company);
  const c = company.success ? company.data : {};
  const ok: Record<RequiredCompanyField, boolean> = {
    name: (c.name ?? '').trim().length >= 2,
    country: /^[A-Z]{2}$/.test(c.country ?? ''),
    supplier_segment: c.supplier_segment === 'it' || c.supplier_segment === 'industrial',
    capabilities: filled(c.capabilities),
    description: (s.profile.description ?? '').trim().length >= 20,
    offerings: filled(s.profile.offerings),
    markets: filled(s.profile.markets),
    customers: filled(s.profile.customers),
  };
  return REQUIRED_COMPANY_FIELDS.filter((f) => !ok[f]);
}

const LABELS: Record<RequiredCompanyField, string> = {
  name: 'company name', country: 'country', supplier_segment: 'segment', capabilities: 'at least one capability',
  description: 'what you do (20+ characters)', offerings: 'at least one offering', markets: 'at least one market', customers: 'who you serve',
};

/** 409 company_incomplete with `missing` when any mandatory value is absent. */
export function assertCompanyComplete(s: Shape): void {
  const missing = missingCompanyFields(s);
  if (missing.length) {
    throw new HttpError(409, `Add ${missing.map((m) => LABELS[m]).join(', ')} before continuing.`, 'company_incomplete', { missing });
  }
}
