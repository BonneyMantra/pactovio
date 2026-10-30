import { HARBOUR, HOUSING, KESTREL, MALTA, MAYNOOTH, METEIREANN, T0, TEAGASC, type Sql } from './seed-lib';

const etenders = (id: number) => `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${id}`;
const sample = { sample: true };

export function seedTenders(s: Sql): void {
  s.put('tenders', {
    id: TEAGASC, source: 'etenders', source_ref: '695163', title: 'Web applications maintenance, support & development services (P4941)',
    buyer: 'Teagasc - Agriculture and Food Development Authority', buyer_key: 'teagasc', country: 'IE', cpv: ['72267100', '72262000', '72212000', '72500000'],
    value_eur: 5_950_000, deadline: '2026-11-19T14:00:00Z', url: etenders(695163),
    lots: [
      { lot_no: '1', title: 'Multiple web applications (Profit Monitor, User Provisioning System, Interactive Forms)' },
      { lot_no: '2', title: 'Nutrient Management Planner (NMP)' },
      { lot_no: '3', title: 'PastureBase Ireland (PBI), including out-of-hours support' },
    ],
    published_at: '2026-10-08T09:00:00Z', raw: { ...sample, cft_id: 'P4941 - 9239900', procedure: 'Open (OJEU)', queries_close: '2026-11-05T14:00:00Z' },
  });
  s.put('tenders', {
    id: METEIREANN, source: 'etenders', source_ref: '701573', title: 'Coastal visibility sensors, spares and ancillaries',
    buyer: 'Met Éireann', buyer_key: 'met-eireann', country: 'IE', cpv: ['38123000', '38200000', '38120000'], value_eur: 220_000,
    deadline: '2026-11-16T11:00:00Z', url: etenders(701573),
    lots: [{ lot_no: '1', title: 'Coastal visibility sensors, spares and ancillaries (goods)' }],
    published_at: '2026-10-20T09:00:00Z', raw: { ...sample, procedure: 'Request for Tenders (goods)', note: 'Visibility observations at coastal locations and 8 Commissioner of Irish Lights stations.' },
  });
  s.put('tenders', {
    id: HOUSING, source: 'etenders', source_ref: '720768', title: 'Website hosting, development, support and maintenance',
    buyer: 'Department of Housing, Local Government and Heritage', buyer_key: 'dept-housing', country: 'IE', cpv: ['72415000', '72212224', '72260000'], value_eur: 400_000,
    deadline: '2026-12-09T12:00:00Z', url: etenders(720768),
    lots: [{ lot_no: '1', title: 'Website hosting, development, support and maintenance' }],
    published_at: '2026-10-15T09:00:00Z', raw: { ...sample, procedure: 'Open', request_for_tender_ref: 'ServicesRFT160125', value_note: 'excl. VAT over the term' },
  });
  s.put('tenders', {
    id: MALTA, source: 'ted', source_ref: 'SPD1/2026/032', title: 'Framework contract for ICT professional services for the National Skills Council',
    buyer: 'National Skills Council (Malta)', buyer_key: 'national-skills-council-mt', country: 'MT', cpv: ['72000000', '72200000', '72220000'], value_eur: 98_000,
    deadline: '2026-11-18T11:00:00Z', url: 'https://www.etenders.gov.mt/epps/cft/prepareViewCfTWS.do?resourceId=714097',
    lots: [{ lot_no: '1', title: 'ICT professional services framework (2 years)' }],
    published_at: '2026-10-19T09:00:00Z', raw: { ...sample, reference: 'SPD1/2026/032', value_note: 'estimated procurement value excl. VAT for two years' },
  });
  s.put('tenders', {
    id: MAYNOOTH, source: 'etenders', source_ref: '728304', title: 'RENEW software consultancy (PCO 545)',
    buyer: 'Maynooth University', buyer_key: 'maynooth-university', country: 'IE', cpv: ['72220000', '72224000', '72200000'], value_eur: null,
    deadline: '2026-11-26T12:00:00Z', url: etenders(728304),
    lots: [{ lot_no: '1', title: 'Software consultancy for the RENEW programme' }],
    published_at: '2026-10-22T09:00:00Z', raw: { ...sample, project_reference: 'PCO 545', stage: 'Expressions of interest / questionnaire; value not published' },
  });

  const m = (ws: string, t: string, fit: number, reason: string, status = 'new') =>
    s.put('tender_matches', { workspace_id: ws, tender_id: t, fit_score: fit, fit_reason: reason, status, created_at: T0 });
  m(HARBOUR, TEAGASC, 94, 'Three-lot web application maintenance and development: matches Harbour Digital core services, ISO 27001 requirement is met, references are comparable in size.', 'shortlisted');
  m(HARBOUR, HOUSING, 81, 'Website hosting, support and development for a government department; within Harbour Digital hosting and CMS experience.');
  m(HARBOUR, MAYNOOTH, 74, 'Software consultancy for a university programme; relevant references in education, value not yet published.');
  m(HARBOUR, MALTA, 52, 'ICT professional services framework in Malta; small value and outside the usual region, but services align.');
  m(KESTREL, METEIREANN, 96, 'Coastal visibility sensors: direct match for the KS-VIS family, RS-485 Modbus output, and an existing coastal observatory reference.', 'shortlisted');
  m(KESTREL, MALTA, 9, 'ICT professional services: not a Kestrel Sensing business.', 'dismissed');

  const d = (id: string, tender: string, filename: string, kind: string, pages: number | null, isForm = false) =>
    s.put('documents', { id, tender_id: tender, workspace_id: null, filename, kind, r2_key: `tenders/${tender}/${filename}`, pages, is_form: isForm });
  d('doc_sample_teagasc_cft', TEAGASC, 'P4941 - CFT for Web applications_services.docx', 'docx', 12);
  d('doc_sample_teagasc_req', TEAGASC, 'P4941_Web_Applications_Requirements.pdf', 'pdf', 24);
  d('doc_sample_teagasc_trd1', TEAGASC, 'P4941_Web_Applications_TRD_LOT1.docx', 'docx', 18, true);
  d('doc_sample_teagasc_trd2', TEAGASC, 'P4941_Web_Applications_TRD_LOT2.docx', 'docx', 18, true);
  d('doc_sample_teagasc_trd3', TEAGASC, 'P4941_Web_Applications_TRD_LOT3.docx', 'docx', 18, true);
  d('doc_sample_teagasc_clar', TEAGASC, 'P4941 Clarifications 21102026A.pdf', 'pdf', 3);
  d('doc_sample_teagasc_nmp', TEAGASC, 'NMP Architecture diagram P4941 LOT2.png', 'image', null);
  d('doc_sample_met_rft', METEIREANN, 'Request for Tenders for Coastal Visibility Sensors.pdf', 'pdf', 20);
  d('doc_sample_met_spec', METEIREANN, 'Appendix 1.1 Specifications for Goods_V1.2.pdf', 'pdf', 9);
  d('doc_sample_met_trd', METEIREANN, 'Tender Response Document.docx', 'docx', 14, true);
  d('doc_sample_met_espd', METEIREANN, 'ESPD Form_VS RFT (Goods).docx', 'docx', 20, true);
  d('doc_sample_met_price', METEIREANN, 'Appendix 2 Pricing Schedule.xlsx', 'xlsx', null, true);
  d('doc_sample_housing_rft', HOUSING, '1. Request for Tender.pdf', 'pdf', 40);
  d('doc_sample_housing_trd', HOUSING, '2. Tender Response Document.docx', 'docx', 16, true);
  d('doc_sample_housing_espd', HOUSING, '3. European Single Procurement Document.docx', 'docx', 20, true);
  d('doc_sample_malta_tender', MALTA, 'Tender Document.pdf', 'pdf', 48);
  d('doc_sample_maynooth_rft', MAYNOOTH, '545 RFT RENEW software consultancy_amended_.docx', 'docx', 20);
  d('doc_sample_maynooth_cost', MAYNOOTH, '545 Cost schedule TRD RENEW software consultancy.xlsx', 'xlsx', null, true);

  const i = (id: string, ws: string, door: string, source: string, title: string, sender: string | null, at: string, status: string, extra: Record<string, unknown> = {}) =>
    s.put('intakes', { id, workspace_id: ws, door, source, title, sender, received_at: at, status, ...extra });
  i('int_sample_teagasc', HARBOUR, 'tender', 'scan', 'Teagasc: web applications maintenance, support & development (P4941)', 'eTenders nightly scan', '2026-10-29T22:05:00Z', 'ready', { tender_id: TEAGASC, classification: { door: 'tender', confidence: 0.99, reason: 'Public tender notice from the nightly scan' } });
  i('int_sample_housing', HARBOUR, 'tender', 'scan', 'Department of Housing: website hosting, development, support and maintenance', 'eTenders nightly scan', '2026-10-29T22:06:00Z', 'classified', { tender_id: HOUSING, classification: { door: 'tender', confidence: 0.98, reason: 'Public tender notice from the nightly scan' } });
  i('int_sample_maynooth', HARBOUR, 'tender', 'scan', 'Maynooth University: RENEW software consultancy', 'eTenders nightly scan', '2026-10-29T22:07:00Z', 'new', { tender_id: MAYNOOTH });
  i('int_sample_rfp_harbour', HARBOUR, 'rfp', 'gmail', 'RFP: managed hosting and support for our case-management portal', 'procurement@lowlands-health.example', '2026-10-30T07:42:00Z', 'classified', { classification: { door: 'rfp', confidence: 0.93, reason: 'Private-sector request for proposal with a response deadline and attached requirements' } });
  i('int_sample_met', KESTREL, 'tender', 'scan', 'Met Éireann: coastal visibility sensors, spares and ancillaries', 'eTenders nightly scan', '2026-10-29T22:08:00Z', 'ready', { tender_id: METEIREANN, classification: { door: 'tender', confidence: 0.99, reason: 'Public tender notice from the nightly scan' } });
  i('int_sample_design_westbay', KESTREL, 'design', 'gmail', 'Fog and visibility monitoring for the berth approach channel', 'harbourmaster@westbay-port.example', '2026-10-30T06:15:00Z', 'ready', { design_request_id: 'dsg_sample_westbay', classification: { door: 'design', confidence: 0.96, reason: 'Customer asks for a technical solution against a specification, no formal tender' } });
}
