import { Doc, type BuiltDoc } from './pdfkit';
import { SAMPLE_LABEL } from './types';

const F = `Harbour Digital Ltd - ${SAMPLE_LABEL}`;
const doc = (title: string) => Doc.create(title, F);

export async function iso27001(): Promise<BuiltDoc> {
  const d = await doc('ISO/IEC 27001:2022 certificate');
  d.frame().center('CERTIFICATE OF REGISTRATION', 11, { gap: 14 }).center('Information Security Management System', 22, { bold: true, gap: 10 })
    .center('ISO/IEC 27001:2022', 26, { bold: true, gap: 22 }).center('This is to certify that', 11)
    .center('HARBOUR DIGITAL LTD', 20, { bold: true }).center('Dock Road, Cork, T12 X4F9, Ireland', 11, { gap: 14 })
    .center('operates an Information Security Management System which complies with the requirements of ISO/IEC 27001:2022 for the following scope:', 11, { gap: 10 })
    .center('Design, development, hosting and support of web applications for public-sector and enterprise customers. Statement of Applicability version 4.2, dated 8 January 2026.', 11, { bold: true, gap: 18 })
    .center('Certificate number: SC-IE-27001-0457   Issued by NSAI (sample issuer)', 10)
    .center('Original certification: 15 March 2024   Valid until: 14 March 2027', 10)
    .center('Surveillance audit: annual. Next surveillance audit due March 2026 (completed).', 10, { gap: 30 })
    .center('Sample company (fictional): this certificate is sample data created for demonstration.', 8);
  return d.build();
}

export async function iso9001(): Promise<BuiltDoc> {
  const d = await doc('ISO 9001:2015 certificate');
  d.frame().center('CERTIFICATE OF REGISTRATION', 11, { gap: 14 }).center('Quality Management System', 22, { bold: true, gap: 10 })
    .center('ISO 9001:2015', 26, { bold: true, gap: 22 }).center('This is to certify that', 11)
    .center('HARBOUR DIGITAL LTD', 20, { bold: true }).center('Dock Road, Cork, T12 X4F9, Ireland', 11, { gap: 14 })
    .center('operates a Quality Management System which complies with the requirements of ISO 9001:2015 for the following scope:', 11, { gap: 10 })
    .center('Software development and managed application support.', 12, { bold: true, gap: 18 })
    .center('Certificate number: SC-IE-9001-1182   Issued by NSAI (sample issuer)', 10)
    .center('Original certification: 10 December 2020   Valid until: 9 December 2026', 10)
    .center('Recertification audit scheduled for November 2026.', 10, { gap: 30 })
    .center('Sample company (fictional): this certificate is sample data created for demonstration.', 8);
  return d.build();
}

export async function infosecPolicy(): Promise<BuiltDoc> {
  const d = await doc('Information security policy');
  d.h1('Information Security Policy').p('Harbour Digital Ltd. Version 3.1, approved by the Managing Director on 12 January 2026. Owner: Head of Security (CISO). Review: annually.');
  d.h2('1. Purpose and scope').p('This policy sets how Harbour Digital protects customer and company information. It applies to all 64 staff, contractors and every system used to design, build, host and support customer web applications, in Ireland and in our two Azure regions (North Europe and West Europe).');
  d.h2('2. Principles').bullets([
    'Confidentiality, integrity and availability are managed through the ISMS certified to ISO/IEC 27001:2022 (certificate SC-IE-27001-0457).',
    'Access is least-privilege and role based. Multi-factor authentication is mandatory for all staff accounts, VPN and cloud consoles.',
    'Customer data is encrypted in transit (TLS 1.2 or higher) and at rest (AES-256). Keys are held in Azure Key Vault with annual rotation.',
    'Production changes follow peer review, automated tests and a documented release approval. Emergency changes are reviewed within 2 working days.',
  ]);
  d.h2('3. Incident response').p('Security incidents are triaged within 1 hour in business hours. Customers are notified without undue delay and within 24 hours of confirmation of a personal-data breach, so that data-controller duties under Article 33 GDPR can be met within 72 hours.');
  d.h2('4. Supplier and personnel security').bullets([
    'All staff are Garda vetted before access to public-sector systems and complete security awareness training annually.',
    'Sub-processors are assessed before use and listed in each customer contract. No customer data leaves the EU/EEA.',
    'Penetration tests are carried out by an independent CREST-accredited firm at least annually and after major releases.',
  ]);
  d.h2('5. Business continuity').p('The business continuity and disaster recovery plan targets an RTO of 4 hours and an RPO of 1 hour for hosted applications, with geo-redundant backups and two recovery tests per year.');
  return d.build();
}

export async function accessibility(): Promise<BuiltDoc> {
  const d = await doc('Accessibility statement');
  d.h1('Accessibility Statement').p('Harbour Digital Ltd commits to building web applications that meet WCAG 2.1 level AA and, from 2026, WCAG 2.2 level AA, in line with the European Accessibility Act and EN 301 549 v3.2.1 as required for public-sector bodies in Ireland.');
  d.h2('How we deliver accessible applications').bullets([
    'Every design system component is tested with keyboard only, NVDA, JAWS and VoiceOver before release.',
    'Automated checks (axe-core) run in the CI pipeline; a build with a serious or critical violation cannot be released.',
    'An independent accessibility audit is carried out on each application before go-live, with findings fixed within 20 working days.',
    'Two of our developers hold IAAP Certified Professional in Web Accessibility (CPWA) status.',
  ]);
  d.h2('Compliance status of our own website').p('harbourdigital.example is fully compliant with WCAG 2.1 AA as audited in September 2025. Known limitation: embedded third-party video captions are supplied by the provider and are being replaced by captioned originals by Q1 2027.');
  d.h2('Feedback and contact').p('Report an accessibility issue to accessibility@harbourdigital.example. We respond within 5 working days. If you are not satisfied, you may contact the National Disability Authority (Ireland).');
  return d.build();
}

export async function insurance(): Promise<BuiltDoc> {
  const d = await doc('Insurance certificate');
  d.h1('Certificate of Insurance').p('Issued by Atlantic Mutual Insurance DAC (sample insurer) on 1 July 2026 to the Insured below. This certificate is evidence of cover in force at the date of issue.');
  d.table([
    ['Item', 'Detail'],
    ['Insured', 'Harbour Digital Ltd, Dock Road, Cork, T12 X4F9, Ireland'],
    ['Policy period', '1 July 2026 to 30 June 2027'],
    ['Professional indemnity (policy PI-IE-884210)', 'EUR 6,500,000 any one claim and in the aggregate; retroactive date 1 January 2015'],
    ['Public liability (policy PL-IE-884211)', 'EUR 13,000,000 any one occurrence'],
    ['Employers liability (policy EL-IE-884212)', 'EUR 13,000,000 any one occurrence'],
    ['Cyber and data protection (policy CY-IE-884213)', 'EUR 3,000,000 any one claim'],
    ['Territory and jurisdiction', 'Ireland, European Union, United Kingdom'],
  ], [2.2, 3.4]);
  d.p('Sample company (fictional): this certificate is sample data created for demonstration.', 8);
  return d.build();
}

export async function turnover(): Promise<BuiltDoc> {
  const d = await doc('Audited turnover statement');
  d.h1('Statement of Turnover, Audited Accounts').p('Harbour Digital Ltd. Extract from the audited financial statements for the year ended 31 December 2025, signed by Ó Briain & Partners, Statutory Auditors (sample firm), with an unqualified opinion.');
  d.table([
    ['Financial year', 'Turnover (EUR)', 'Of which public sector (EUR)', 'Average staff'],
    ['2025', '9,800,000', '5,390,000', '64'],
    ['2024', '9,000,000', '4,680,000', '58'],
    ['2023', '8,100,000', '3,890,000', '51'],
  ], [1.2, 1.5, 2.2, 1.2]);
  d.p('Turnover in each of the last three financial years exceeded EUR 8,000,000. The company has no going-concern uncertainty and net current assets of EUR 2,140,000 at 31 December 2025.');
  d.p('Sample company (fictional): this statement is sample data created for demonstration.', 8);
  return d.build();
}
