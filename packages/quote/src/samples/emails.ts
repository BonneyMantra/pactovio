import { Doc } from './pdfkit';
import { SAMPLE_LABEL } from './types';

export interface SampleEmail {
  id: string;
  workspace_id: string;
  to: string;
  from: { name: string; address: string };
  subject: string;
  date: string;
  body_text: string;
  attachments: { filename: string; mime: string; path: string }[];
  /** Ground truth for classifier tests and the Gmail E2E. */
  expected: { door: 'design' | 'rfp' | 'tender' | 'ignore'; reason: string; buyer_country?: string; buyer_b2b?: boolean };
}

const K = 'ws_kestrel_sensing';
const H = 'ws_harbour_digital';

export const EMAILS: SampleEmail[] = [
  {
    id: 'mail_k_port_fog', workspace_id: K, to: 'sales@kestrel-sensing.example', from: { name: 'Ciarán Doyle', address: 'ciaran.doyle@westbay-port.example' },
    subject: 'Fog monitoring for the Berth 4 to 9 approach: can you design and quote?', date: '2026-10-27T09:14:00Z',
    body_text: `Hello,

Westbay Port Authority is replacing manual fog observations on the quay with continuous visibility monitoring. Our harbour master needs early warning before visibility on the approach channel drops below 500 m.

Requirements as they stand:
- Six monitoring stations along Berths 4 to 9.
- Visibility measurement range from 10 m up to at least 10 km, accuracy better than 10%.
- Our operations system polls over RS-485 Modbus RTU, so the sensor, or a gateway beside it, must speak Modbus RTU.
- Backhaul over 4G with a backup SIM. There is no fixed line on the quay edge.
- Stations are solar powered; budget is under 15 W continuous per station, including the gateway.
- Exposed to salt spray on the quay structure: IP66 or better, marine grade.
- One-minute data logging with local storage if the link drops.
- CE marked equipment; mounting masts of about 3 m.
- Installation and commissioning on site, and a hosted dashboard for the harbour master.
- Delivery within 12 weeks of order.

Please send a design and a priced quote in EUR. We are a public body registered in Ireland.

Kind regards,
Ciarán Doyle
Marine Systems Engineer, Westbay Port Authority
Westbay Harbour Office, Westbay, Co. Mayo, Ireland`,
    attachments: [], expected: { door: 'design', reason: 'Technical product requirements and a request to design and quote', buyer_country: 'IE', buyer_b2b: true },
  },
  {
    id: 'mail_k_windfarm_met', workspace_id: K, to: 'sales@kestrel-sensing.example', from: { name: 'Katharina Vogel', address: 'k.vogel@nordwind-energie.example' },
    subject: 'Anfrage / Enquiry: visibility and cloud-base on two met masts, Lüneburger Heide repower', date: '2026-10-28T13:41:00Z',
    body_text: `Dear Kestrel team,

Nordwind Energie GmbH (Hamburg, VAT DE811234567) is repowering the Lüneburger Heide wind farm and wants to add low-visibility and cloud-base measurements to two new 100 m met masts, to support icing and shutdown forecasting.

What we need per mast:
- One visibility sensor, range 10 m to at least 50 km, SDI-12 or Modbus RTU output.
- One cloud-base ceilometer, range to 7 km or more, three layers, Modbus RTU or RS-232.
- A data logger that polls both over Modbus and SDI-12, 12 channels or more, 1-minute averages, at least 90 days local storage, sub-1 W draw (battery plus solar mast supply).
- Operating temperature down to -30 °C, IP65 or better.
- Cellular backhaul to our SCADA over MQTT with TLS.
- A cloud data service so our forecasting team can pull the data by API; 5 years retention.

Please quote for two complete sets plus remote commissioning support, in EUR. Lead time under 10 weeks if possible.

Mit freundlichen Grüßen,
Katharina Vogel
Head of Met Systems, Nordwind Energie GmbH`,
    attachments: [], expected: { door: 'design', reason: 'Engineering spec for met-mast instruments with a quote request; EU B2B buyer with VAT id', buyer_country: 'DE', buyer_b2b: true },
  },
  {
    id: 'mail_k_county_rwis', workspace_id: K, to: 'sales@kestrel-sensing.example', from: { name: 'Deirdre Hanlon', address: 'dhanlon@kilbrook-cc.example' },
    subject: 'Road weather station refresh, 12 sites: heated sensors, quote please', date: '2026-10-29T08:02:00Z',
    body_text: `Hi,

Kilbrook County Council is refreshing its winter-maintenance road weather information system. Twelve existing stations on exposed mountain-pass routes need new sensors and a new communications unit.

Per site:
- A heated visibility sensor, 10 m to 20 km or better, SDI-12 output preferred (our existing logger is SDI-12 only).
- A present-weather sensor that distinguishes rain, snow, freezing rain and fog.
- Operation down to -30 °C, IP66, mast mounted (3 m).
- A 4G unit with SIM failover, reporting every minute to our central server over MQTT.
- Mains is not available on seven of the twelve sites, so solar power under 15 W total.

We also need on-site installation for all twelve sites (about 1 day each) and a five-year data service. Pricing in EUR ex VAT with your best volume discount, please. Funding closes in December so we need the quote within two weeks.

Regards,
Deirdre Hanlon
Roads and Transportation, Kilbrook County Council, Ireland`,
    attachments: [], expected: { door: 'design', reason: 'County council asking for product design and priced quote for multi-site refresh', buyer_country: 'IE', buyer_b2b: true },
  },
  {
    id: 'mail_k_newsletter', workspace_id: K, to: 'sales@kestrel-sensing.example', from: { name: 'Meteo Instruments Weekly', address: 'newsletter@meteo-instruments-weekly.example' },
    subject: 'This week: 5 new fog sensors reviewed, WMO CIMO guide update, and a webinar on icing', date: '2026-10-28T06:00:00Z',
    body_text: `Meteo Instruments Weekly  |  Issue 212

In this issue
- Review: five forward-scatter visibility sensors compared
- WMO CIMO Guide 2026 edition: what changed for visibility
- Webinar (12 Nov, 15:00 GMT): Measuring icing on wind turbines
- Jobs board and trade-show calendar

Advertise with us: reach 18,000 meteorology professionals. Reply to this email for the 2027 media pack.

You are receiving this because you subscribed at meteo-instruments-weekly.example. Unsubscribe: https://meteo-instruments-weekly.example/unsubscribe`,
    attachments: [], expected: { door: 'ignore', reason: 'Newsletter and advertising, no request to Kestrel' },
  },
  {
    id: 'mail_h_rfp_planning', workspace_id: H, to: 'bids@harbourdigital.example', from: { name: 'Fionnuala Rice', address: 'procurement@corran-cc.example' },
    subject: 'Request for Proposals: Planning enforcement case management web application (RFP CCC-2026-14)', date: '2026-10-26T10:30:00Z',
    body_text: `Dear Sir or Madam,

Corran County Council invites proposals for the design, build and four-year support of a planning enforcement case management web application. The full Request for Proposals is attached (PDF, 3 pages). Your response should reach us by 4 December 2026, 12:00 noon.

Please acknowledge receipt, and send any clarification questions by 13 November 2026.

Fionnuala Rice
Procurement Officer, Corran County Council
procurement@corran-cc.example`,
    attachments: [{ filename: 'RFP-CCC-2026-14-planning-enforcement.pdf', mime: 'application/pdf', path: 'attachments/RFP-CCC-2026-14-planning-enforcement.pdf' }],
    expected: { door: 'rfp', reason: 'Named buyer issuing an RFP with a deadline and an attached document', buyer_country: 'IE', buyer_b2b: true },
  },
];

export async function rfpPdf() {
  const d = await Doc.create('RFP CCC-2026-14', `Corran County Council - ${SAMPLE_LABEL}`);
  d.h1('Request for Proposals CCC-2026-14').p('Planning enforcement case management web application. Issued 26 October 2026 by Corran County Council (sample buyer). Estimated value EUR 780,000 over four years excluding VAT.');
  d.h2('1. Timetable').table([['Milestone', 'Date'], ['Clarification questions close', '13 November 2026, 12:00'], ['Proposals due', '4 December 2026, 12:00 noon'], ['Contract start', '1 March 2027']], [3, 3]);
  d.h2('2. Mandatory requirements').bullets([
    'M1. Tenderer holds ISO/IEC 27001:2022 certification covering hosting and support of web applications.',
    'M2. Professional indemnity insurance of at least EUR 5,000,000 and public liability insurance of at least EUR 10,000,000.',
    'M3. Average annual turnover of at least EUR 4,000,000 over the last three financial years.',
    'M4. Two references for comparable public-sector web applications delivered in the last five years.',
    'M5. The application must meet WCAG 2.1 level AA and the Council will require an independent accessibility audit before go-live.',
  ]);
  d.h2('3. Scored questions (total 100 marks)').table([
    ['Ref', 'Question', 'Marks', 'Limit'],
    ['Q1', 'Describe your approach to delivery and how you will migrate 41,000 existing case records.', '30', '600 words'],
    ['Q2', 'Describe your hosting architecture, backup, and recovery targets.', '25', '400 words'],
    ['Q3', 'Describe your 24x5 support model and escalation, with named roles.', '25', '400 words'],
    ['Q4', 'Describe your information security and incident-response practice.', '20', '400 words'],
  ], [0.7, 4.8, 0.8, 1.2]);
  d.h2('4. Submission').p('Submit the response form (Appendix A, to be requested by email) and supporting evidence as one PDF. Late proposals will not be considered.');
  return d.build();
}
