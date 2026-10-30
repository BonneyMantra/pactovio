import { toRow } from '@pactovio/contracts';
import { EMAILS } from '@pactovio/quote/samples';

const q = (v: string | number | null): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

const DESIGN: { id: string; email: string; customer: string; intake: string | null }[] = [
  { id: 'dsg_sample_westbay', email: 'mail_k_port_fog', customer: 'Westbay Port Authority (sample customer)', intake: 'int_sample_design_westbay' },
  { id: 'dsg_k_nordwind', email: 'mail_k_windfarm_met', customer: 'Nordwind Energie GmbH (sample customer)', intake: null },
  { id: 'dsg_k_kilbrook', email: 'mail_k_county_rwis', customer: 'Kilbrook County Council (sample customer)', intake: null },
];

/** Three Kestrel design requests, unmatched: the match and quote steps are what the demo shows. Resets earlier sample state for these ids. */
export function designSql(): string[] {
  return [
    `DELETE FROM quotes WHERE id = 'quo_sample_westbay';`,
    ...DESIGN.map((d) => {
      const e = EMAILS.find((x) => x.id === d.email)!;
      const row = toRow({ id: d.id, workspace_id: 'ws_kestrel_sensing', intake_id: d.intake, customer: d.customer, subject: e.subject, spec_text: e.body_text, requirements: [], matches: [], status: 'new' });
      const cols = Object.keys(row);
      return `INSERT INTO design_requests (${cols.join(', ')}) VALUES (${cols.map((c) => q(row[c]!)).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')};`;
    }),
  ];
}
