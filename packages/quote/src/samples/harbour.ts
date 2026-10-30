import { CASES, caseStudy } from './harbour-cases';
import { CVS, cvDoc } from './harbour-cvs';
import * as H from './harbour-docs';
import { pdfMime, type SampleFile } from './types';
import type { BuiltDoc } from './pdfkit';

export const HARBOUR_WS = 'ws_harbour_digital';

/** The ISO 9001 certificate ships as a PNG scan (made by seed-samples-scan.py from `iso9001()`); pass its bytes in. */
export async function buildHarbour(scanPng: Uint8Array | null): Promise<SampleFile[]> {
  const out: SampleFile[] = [];
  const add = async (id: string, kind: string, title: string, issuer: string | null, scope: string | null, valid_to: string | null, filename: string, doc: BuiltDoc, meta: Record<string, unknown> = {}) =>
    out.push({ id, workspace_id: HARBOUR_WS, kind, title, issuer, scope, valid_to, filename, mime: pdfMime, bytes: doc.bytes, pages: doc.pages, meta: { sample: true, company: 'Harbour Digital Ltd', ...meta } });

  await add('evd_sample_iso27001', 'certificate', 'ISO/IEC 27001:2022 certificate', 'NSAI', 'Design, development, hosting and support of web applications', '2027-03-14', 'iso-27001-certificate.pdf', await H.iso27001());
  const iso9001 = await H.iso9001();
  if (scanPng) {
    out.push({ id: 'evd_sample_iso9001', workspace_id: HARBOUR_WS, kind: 'certificate', title: 'ISO 9001:2015 certificate (scanned)', issuer: 'NSAI', scope: 'Software development and managed application support', valid_to: '2026-12-09', filename: 'iso-9001-certificate-scan.png', mime: 'image/png', bytes: scanPng, pages: [iso9001.pages[0]!], meta: { sample: true, company: 'Harbour Digital Ltd', scan: true, text_source: 'generator transcript, not OCR; a vision model should read the image at ingest' } });
  } else await add('evd_sample_iso9001', 'certificate', 'ISO 9001:2015 certificate', 'NSAI', 'Software development and managed application support', '2026-12-09', 'iso-9001-certificate.pdf', iso9001);
  await add('evd_h_infosec', 'policy', 'Information security policy v3.1', 'Harbour Digital Ltd', 'All staff and systems', null, 'information-security-policy.pdf', await H.infosecPolicy());
  await add('evd_h_a11y', 'policy', 'Accessibility statement (WCAG 2.1 AA / EN 301 549)', 'Harbour Digital Ltd', null, null, 'accessibility-statement.pdf', await H.accessibility());
  for (const c of CASES) await add(c.id, 'case_study', `Case study: ${c.title}`, 'Harbour Digital Ltd', null, null, c.file, await caseStudy(c));
  for (const c of CVS) await add(c.id, 'cv', `CV summary: ${c.name}, ${c.role}`, 'Harbour Digital Ltd', c.role, null, c.file, await cvDoc(c));
  await add('evd_h_insurance', 'insurance', 'Insurance certificate: PI EUR 6.5M, PL EUR 13M', 'Atlantic Mutual Insurance DAC (sample insurer)', 'Professional indemnity, public liability, employers liability, cyber', '2027-06-30', 'insurance-certificate.pdf', await H.insurance());
  await add('evd_sample_accounts', 'financial', 'Audited turnover statement FY2023 to FY2025', 'Harbour Digital Ltd', null, null, 'audited-turnover-statement.pdf', await H.turnover());
  return out;
}

export { iso9001 } from './harbour-docs';
