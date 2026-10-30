import { Doc, type BuiltDoc } from './pdfkit';
import { SAMPLE_LABEL } from './types';

const F = `Harbour Digital Ltd - ${SAMPLE_LABEL}`;

interface Case { title: string; client: string; period: string; value: string; summary: string; scope: string[]; results: string[]; refName: string }

export const CASES: (Case & { id: string; file: string })[] = [
  { id: 'evd_sample_ref_water', file: 'case-study-munster-water.pdf', title: 'Munster Regional Water Authority customer portal', client: 'Munster Regional Water Authority (sample customer)', period: 'Jan 2023 to present', value: 'EUR 1.85M over four years',
    summary: 'Rebuilt the customer self-service portal for 310,000 accounts with billing integration. 99.95% availability over 18 months. Four-year maintenance contract with 24x5 support, quarterly releases, and monthly service reports.',
    scope: ['ASP.NET Core and React web application on Azure App Service', 'Integration with the SAP billing system through a hardened API layer', 'WCAG 2.1 AA, Irish and English language'],
    results: ['310,000 customer accounts migrated with zero billing discrepancies', '99.95% availability measured over 18 months', 'Average call-centre contacts down 27% after launch'], refName: 'Head of Digital Services' },
  { id: 'evd_sample_ref_board', file: 'case-study-atlantic-tu-board.pdf', title: 'Atlantic Technological Board student records', client: 'Atlantic Technological Board (sample customer)', period: 'Sep 2022 to present', value: 'EUR 960K over three years',
    summary: 'Maintenance and development for three student-facing web applications with 24x5 support, take-on from the previous supplier in six weeks, and documented handover procedures.',
    scope: ['Admissions, results and timetable web applications for 14,000 students', 'Take-on from the incumbent supplier with a documented transition plan', 'Quarterly releases and a named service delivery manager'],
    results: ['Transition completed in six weeks with no service interruption', '97% of priority-1 incidents resolved inside the 4-hour target', 'Student satisfaction with the portal up from 61% to 84%'], refName: 'Registrar' },
  { id: 'evd_h_case_3', file: 'case-study-county-planning.pdf', title: 'County Council planning applications portal', client: 'Corran County Council (sample customer)', period: 'Mar 2024 to Feb 2025', value: 'EUR 640K fixed price',
    summary: 'Delivered a public planning applications web application with map-based search, online submissions and fee payment in 9 months, on a fixed price and one week early.',
    scope: ['Public search with GIS map layers and document viewer', 'Online submission with virus scanning and payment through the national payment gateway', 'ISO 27001 controls applied to hosting and release'],
    results: ['41,000 applications searchable at launch', 'Online submission share rose from 18% to 72% in the first year', 'Passed independent WCAG audit with no critical findings'], refName: 'Director of Services, Planning' },
  { id: 'evd_h_case_4', file: 'case-study-health-agency-forms.pdf', title: 'National Health Agency digital forms platform', client: 'National Health Agency (sample customer)', period: 'Jun 2023 to Dec 2024', value: 'EUR 1.1M',
    summary: 'Built and runs a digital forms platform handling 220,000 submissions a year with role-based workflow, audit trail and 24x5 support, hosted in Azure North Europe.',
    scope: ['Configurable forms and workflow engine on Azure Functions and Cosmos DB', 'Single sign-on with the agency identity provider (SAML 2.0)', 'Penetration test and DPIA completed before go-live'],
    results: ['220,000 submissions a year, 99.9% availability', 'Average processing time cut from 11 days to 3 days', 'No data-protection incidents since launch'], refName: 'Head of ICT'},
];

export async function caseStudy(c: (typeof CASES)[number]): Promise<BuiltDoc> {
  const d = await Doc.create(`Case study: ${c.title}`, F);
  d.h1('Case study').h2(c.title);
  d.table([['Client', 'Period', 'Contract value'], [c.client, c.period, c.value]], [3, 1.6, 1.8]);
  d.h2('Summary').p(c.summary);
  d.h2('What we delivered').bullets(c.scope);
  d.h2('Results').bullets(c.results);
  d.h2('Reference').p(`The ${c.refName} at the client can be contacted with the customer's consent. Contact details are supplied on request.`);
  return d.build();
}
