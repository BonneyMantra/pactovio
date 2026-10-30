import type { CompanyProfile } from '@pactovio/contracts';
import { HARBOUR, KESTREL, T0, type Sql } from './seed-lib';

const eur = (m: number) => Math.round(m * 100);

export const harbourProfile: CompanyProfile = {
  legal_name: 'Harbour Digital Ltd',
  sample_label: 'Sample company',
  tagline: 'Web and cloud application services for Irish public-sector and semi-state bodies.',
  hq: { city: 'Cork', country: 'IE' },
  sites: [{ city: 'Cork', country: 'IE', role: 'Headquarters and delivery centre' }, { city: 'Dublin', country: 'IE', role: 'Client engagement office' }],
  founded: 2012,
  staff: { total: 64, by_role: { engineers: 38, designers: 6, project_managers: 8, qa: 6, security: 3, leadership_admin: 3 } },
  turnover: [
    { year: 2023, amount_minor: eur(8_100_000), currency: 'EUR' },
    { year: 2024, amount_minor: eur(9_000_000), currency: 'EUR' },
    { year: 2025, amount_minor: eur(9_800_000), currency: 'EUR' },
  ],
  services: [
    'Web application maintenance, support and development', 'Cloud hosting and managed operations (Azure, AWS)', 'Legacy .NET and Java modernisation',
    'Portal and forms platforms', 'Data integration and API development', 'Accessibility (WCAG 2.2 AA) and UX design', 'Security testing and secure SDLC',
  ],
  capabilities: ['.NET 8', 'Java 21 / Spring', 'React and TypeScript', 'PostgreSQL and SQL Server', 'Azure DevOps CI/CD', 'Terraform', '24x5 service desk (08:00-20:00 IST, Mon-Fri)'],
  certifications: [
    { name: 'ISO/IEC 27001:2022', scope: 'Design, development, hosting and support of web applications', issuer: 'NSAI', valid_from: '2024-03-15', valid_to: '2027-03-14' },
    { name: 'ISO 9001:2015', scope: 'Software development and managed application support', issuer: 'NSAI', valid_from: '2023-12-10', valid_to: '2026-12-09' },
    { name: 'Cyber Essentials Plus', scope: 'Corporate IT and delivery environments', issuer: 'IASME', valid_from: '2026-01-21', valid_to: '2027-01-20' },
  ],
  references: [
    { client: 'Munster Regional Water Authority', title: 'Customer self-service portal and billing integration', sector: 'Utilities', year: 2024, value_minor: eur(1_450_000), currency: 'EUR', summary: 'Rebuilt the customer portal for 310,000 accounts; 99.95% availability over 18 months; 4-year maintenance contract in force.' },
    { client: 'Atlantic Technological Board', title: 'Student records web applications support (3 applications)', sector: 'Education', year: 2023, value_minor: eur(920_000), currency: 'EUR', summary: 'Maintenance and development for three student-facing applications with 24x5 support and quarterly release cadence.' },
    { client: 'County Harbour Commission', title: 'Vessel registration and licensing platform', sector: 'Public sector', year: 2025, value_minor: eur(610_000), currency: 'EUR', summary: 'Greenfield licensing platform with payments and document workflow; delivered on time, WCAG 2.2 AA audited.' },
  ],
  insurance: { currency: 'EUR', public_liability_minor: eur(6_000_000), professional_indemnity_minor: eur(5_000_000), employers_liability_minor: eur(13_000_000), cyber_minor: eur(3_000_000) },
  regions: ['IE', 'EU'],
  cpv_focus: ['72200000', '72210000', '72212000', '72230000', '72260000', '72261000', '72262000', '72500000', '72600000'],
  keywords: ['web application', 'maintenance', 'support', 'hosting', 'portal', 'cloud', 'software development', 'public sector'],
};

export const kestrelProfile: CompanyProfile = {
  legal_name: 'Kestrel Sensing Ltd',
  sample_label: 'Sample company',
  tagline: 'Environmental and visibility sensors, data loggers and IoT gateways, engineered in Galway and built in Pune.',
  hq: { city: 'Galway', country: 'IE' },
  sites: [{ city: 'Galway', country: 'IE', role: 'Headquarters, R&D and calibration lab' }, { city: 'Pune', country: 'IN', role: 'Manufacturing and assembly' }],
  founded: 2009,
  staff: { total: 140, by_role: { manufacturing: 62, engineering: 34, quality: 10, sales: 14, support: 12, admin: 8 } },
  turnover: [
    { year: 2023, amount_minor: eur(14_200_000), currency: 'EUR' },
    { year: 2024, amount_minor: eur(16_300_000), currency: 'EUR' },
    { year: 2025, amount_minor: eur(18_600_000), currency: 'EUR' },
  ],
  services: ['Visibility and present-weather sensors', 'Automatic weather station data loggers', 'IoT gateways (Modbus, MQTT, 4G)', 'Calibration and traceable test certificates', 'Installation support and 5-year maintenance contracts'],
  capabilities: ['Forward-scatter visibility 10 m to 32 km MOR', 'RS-485 Modbus RTU and SDI-12 outputs', 'IP66 marine-grade housings', 'Solar and low-power (under 3 W) operation', 'Dual-SIM LTE Cat-4 backhaul', 'In-house EMC pre-compliance'],
  certifications: [
    { name: 'ISO 9001:2015', scope: 'Design, manufacture and calibration of environmental sensors and data loggers', issuer: 'NSAI', valid_from: '2024-06-02', valid_to: '2027-06-01' },
    { name: 'CE marking (EMC 2014/30/EU, RED 2014/53/EU)', scope: 'KS-VIS, KS-LOG and KS-GW product families', issuer: 'Self-declared with notified-body test reports', valid_from: '2025-02-01', valid_to: null },
    { name: 'RoHS (2011/65/EU) declaration', scope: 'All current products', issuer: 'Self-declared with material declarations', valid_from: '2025-02-01', valid_to: null },
  ],
  references: [
    { client: 'Northern Coastal Observatory', title: '38 coastal visibility and weather stations', sector: 'Meteorology', year: 2024, value_minor: eur(410_000), currency: 'EUR', summary: 'Supplied and commissioned 38 stations with RS-485 outputs and 4G backhaul; 98.7% data availability in year one.' },
    { client: 'Estuary Ports Group', title: 'Fog monitoring for four berth approaches', sector: 'Ports', year: 2025, value_minor: eur(186_000), currency: 'EUR', summary: 'Visibility sensors and gateways feeding the port operations system over Modbus.' },
    { client: 'Alpine Highway Operator', title: 'Road weather information system sensors', sector: 'Transport', year: 2023, value_minor: eur(530_000), currency: 'EUR', summary: '120 heated visibility sensors on exposed passes, 5-year maintenance contract.' },
  ],
  insurance: { currency: 'EUR', public_liability_minor: eur(5_000_000), professional_indemnity_minor: eur(2_500_000), employers_liability_minor: eur(13_000_000) },
  regions: ['IE', 'EU', 'UK', 'IN'],
  cpv_focus: ['38120000', '38123000', '38200000', '38400000', '32441300', '31600000'],
  keywords: ['visibility sensor', 'meteorological', 'data logger', 'IoT gateway', 'Modbus', 'coastal', 'environmental monitoring'],
};

export function seedCompanies(s: Sql): void {
  s.put('workspaces', { id: HARBOUR, name: 'Harbour Digital Ltd (Sample company)', segment: 'it', profile: harbourProfile, sample: true, created_at: T0 });
  s.put('workspaces', { id: KESTREL, name: 'Kestrel Sensing Ltd (Sample company)', segment: 'industrial', profile: kestrelProfile, sample: true, created_at: T0 });
  for (const ws of [HARBOUR, KESTREL]) s.put('subscriptions', { workspace_id: ws, plan: 'free', status: 'active' });
  s.put('credit_ledger', { id: 'led_sample_harbour_grant', workspace_id: HARBOUR, delta: 20, reason: 'sample_grant', ref: 'sample_grant', at: T0 });
  s.put('credit_ledger', { id: 'led_sample_kestrel_grant', workspace_id: KESTREL, delta: 20, reason: 'sample_grant', ref: 'sample_grant', at: T0 });
  s.put('connectors', { id: 'cnx_sample_slack_harbour', workspace_id: HARBOUR, provider: 'slack', status: 'connected', external_account_id: 'sample-workspace', meta: { sample: true, channel: '#bids' }, connected_at: T0 });
}
