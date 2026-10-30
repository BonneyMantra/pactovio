import { Doc, type BuiltDoc } from './pdfkit';
import { SAMPLE_LABEL } from './types';

const F = `Harbour Digital Ltd - ${SAMPLE_LABEL}`;

export const CVS = [
  { id: 'evd_h_cv_1', file: 'cv-aoife-brennan.pdf', name: 'Aoife Brennan', role: 'Delivery Director', years: 18, quals: 'BSc Computer Science (UCC); PRINCE2 Practitioner; ITIL 4 Managing Professional',
    exp: ['Leads all public-sector accounts; accountable for the Munster Water and Atlantic Technological Board contracts', 'Previously Programme Manager at a national telecoms provider (2008 to 2016)', 'Led six contract take-ons from incumbent suppliers, each inside 8 weeks'] },
  { id: 'evd_h_cv_2', file: 'cv-conor-walsh.pdf', name: 'Conor Walsh', role: 'Solution Architect', years: 15, quals: 'MSc Software Engineering (TU Dublin); Microsoft Certified Azure Solutions Architect Expert',
    exp: ['Architect of the Munster Water portal and the National Health Agency forms platform', 'Designs resilient Azure hosting with RTO 4 h and RPO 1 h targets', 'Speaker on public-sector cloud migration at Irish digital government events'] },
  { id: 'evd_h_cv_3', file: 'cv-siobhan-ocallaghan.pdf', name: 'Siobhán O\'Callaghan', role: 'Head of Security (CISO)', years: 14, quals: 'BSc Computing (MTU); CISSP; ISO/IEC 27001 Lead Auditor; CISM',
    exp: ['Owns the ISMS certified to ISO/IEC 27001:2022 and the incident response process', 'Leads annual independent penetration testing and supplier security assessments', 'Seconded to a government agency security review in 2021'] },
  { id: 'evd_h_cv_4', file: 'cv-darragh-murphy.pdf', name: 'Darragh Murphy', role: 'Lead Developer, .NET and React', years: 12, quals: 'BSc Software Development (ATU); Microsoft Certified Developer Associate',
    exp: ['Technical lead on three maintained web applications, 24x5 on-call rota member', 'Introduced contract testing and trunk-based releases that cut lead time by 40%', 'Mentors a team of eight developers'] },
  { id: 'evd_h_cv_5', file: 'cv-niamh-kelleher.pdf', name: 'Niamh Kelleher', role: 'Accessibility and UX Lead', years: 11, quals: 'MA Interaction Design (NCAD); IAAP Certified Professional in Web Accessibility (CPWA)',
    exp: ['Leads WCAG 2.1 AA conformance on every release and the accessibility statement', 'Designed the Corran County Council planning portal (independent audit, no critical findings)', 'Runs assistive-technology testing sessions with users each quarter'] },
  { id: 'evd_h_cv_6', file: 'cv-eoin-fitzgerald.pdf', name: 'Eoin Fitzgerald', role: 'Service Delivery Manager', years: 13, quals: 'BA Business Information Systems (UCC); ITIL 4 Foundation; PRINCE2 Agile',
    exp: ['Runs the 24x5 service desk and monthly service reports for public-sector customers', 'Achieves 97% of priority-1 incidents resolved inside the 4-hour target', 'Single named escalation point for customers during incidents'] },
];

export async function cvDoc(c: (typeof CVS)[number]): Promise<BuiltDoc> {
  const d = await Doc.create(`CV summary: ${c.name}`, F);
  d.h1(c.name).p(`${c.role}, Harbour Digital Ltd. ${c.years} years of experience.`);
  d.h2('Qualifications').p(c.quals);
  d.h2('Relevant experience').bullets(c.exp);
  d.p('Sample company (fictional): CV summary is sample data created for demonstration; persons are fictional.', 8);
  return d.build();
}
