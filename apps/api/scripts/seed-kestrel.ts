import { KESTREL, type Sql } from './seed-lib';

const eur = (n: number) => Math.round(n * 100);

export function seedKestrel(s: Sql): void {
  const ev = (id: string, kind: string, title: string, issuer: string | null, valid_to: string | null, text: string) =>
    s.put('evidence', { id, workspace_id: KESTREL, kind, title, issuer, scope: null, valid_to, r2_key: null, text, meta: { sample: true } });
  ev('evd_sample_k_iso9001', 'certificate', 'ISO 9001:2015 certificate', 'NSAI', '2027-06-01', 'Kestrel Sensing Ltd is certified to ISO 9001:2015 for design, manufacture and calibration of environmental sensors and data loggers. Valid to 1 June 2027.');
  ev('evd_sample_k_ce', 'certificate', 'CE declaration of conformity KS-VIS family', 'Kestrel Sensing Ltd', null, 'KS-VIS-200 and KS-VIS-500 conform to EMC 2014/30/EU and RED 2014/53/EU. Notified-body test reports on file.');
  ev('evd_sample_k_rohs', 'certificate', 'RoHS declaration', 'Kestrel Sensing Ltd', null, 'All current Kestrel Sensing products conform to RoHS 2011/65/EU. Material declarations held for every component.');
  ev('evd_sample_k_ref_obs', 'case_study', 'Northern Coastal Observatory: 38 coastal stations', 'Kestrel Sensing Ltd', null, 'Supplied and commissioned 38 coastal visibility and weather stations with RS-485 Modbus outputs and 4G backhaul. 98.7% data availability in the first year.');
  ev('evd_sample_k_datasheet_vis200', 'datasheet', 'KS-VIS-200 datasheet', 'Kestrel Sensing Ltd', null, 'KS-VIS-200 forward-scatter visibility sensor. MOR range 10 m to 20 km, accuracy 10% to 10 km, RS-485 Modbus RTU, IP66, 12-24 V DC, 2.4 W typical, heated lens option.');

  const p = (n: number, sku: string, name: string, family: string, specs: Record<string, unknown>, price: number) =>
    s.put('products', { id: `prd_sample_${n}`, workspace_id: KESTREL, sku, name, family, specs, datasheet_doc_id: null, unit_price_minor: eur(price), currency: 'EUR' });
  p(1, 'KS-VIS-200', 'KS-VIS-200 visibility sensor', 'Visibility', { range_m: [10, 20000], accuracy: '10% to 10 km', interfaces: ['RS-485 Modbus RTU', 'SDI-12'], ingress: 'IP66', supply_v: [12, 24], power_w_typ: 2.4, marine_coating: true }, 2480);
  p(2, 'KS-VIS-500', 'KS-VIS-500 long-range visibility sensor', 'Visibility', { range_m: [10, 32000], accuracy: '8% to 10 km', interfaces: ['RS-485 Modbus RTU', 'Ethernet Modbus TCP'], ingress: 'IP66', supply_v: [12, 24], power_w_typ: 3.1, marine_coating: true }, 3890);
  p(3, 'KS-LOG-8', 'KS-LOG-8 data logger', 'Loggers', { channels: 8, interfaces: ['RS-485 Modbus RTU master', 'SDI-12', '4-20 mA'], storage_days_1min: 180, supply_v: [9, 28] }, 890);
  p(4, 'KS-GW-4G', 'KS-GW-4G IoT gateway', 'Gateways', { backhaul: 'LTE Cat-4, dual SIM', protocols: ['Modbus RTU to TCP', 'MQTT', 'HTTPS'], ingress: 'IP65', supply_v: [9, 36], power_w_typ: 2.2 }, 640);
  p(5, 'KS-PWR-SOL20', 'KS-PWR-SOL20 solar power kit', 'Power', { panel_w: 20, battery_wh: 120, autonomy_days: 5, ingress: 'IP65' }, 520);

  s.put('price_rules', { id: 'prl_sample_volume', workspace_id: KESTREL, kind: 'volume_discount', rule: { tiers: [{ min_qty: 5, discount_bp: 300 }, { min_qty: 10, discount_bp: 600 }, { min_qty: 25, discount_bp: 1000 }], applies_to: 'line' } });
  s.put('price_rules', { id: 'prl_sample_tax', workspace_id: KESTREL, kind: 'tax', rule: { name: 'VAT (Ireland)', rate_bp: 2300 } });

  s.put('design_requests', {
    id: 'dsg_sample_westbay', workspace_id: KESTREL, intake_id: 'int_sample_design_westbay', customer: 'Westbay Port Authority (sample customer)',
    subject: 'Fog and visibility monitoring for the berth approach channel',
    spec_text: 'We need six visibility monitoring stations along the approach channel to give the harbour master early warning of fog. Measurement range 10 m to at least 10 km. Stations are remote, solar powered with a consumption budget under 15 W each, and must report over a cellular link with a backup SIM. Our operations system reads sensors over RS-485 Modbus RTU, so the sensor or its gateway must speak Modbus RTU. Equipment is mounted on exposed quay structures, IP66 and salt-spray resistant. One-minute logging, CE marked. Delivery within 12 weeks. Please quote.',
    requirements: [
      { key: 'visibility_range', text: 'Visibility measurement range 10 m to at least 10 km', value: '10 m - 10 km', mandatory: true },
      { key: 'interface', text: 'RS-485 Modbus RTU to the operations system', value: 'RS-485 Modbus RTU', mandatory: true },
      { key: 'backhaul', text: 'Cellular backhaul with backup SIM', value: 'LTE, dual SIM', mandatory: true },
      { key: 'power', text: 'Solar powered, under 15 W per station', value: '< 15 W', mandatory: true },
      { key: 'ingress', text: 'IP66 and salt-spray resistant', value: 'IP66, marine', mandatory: true },
      { key: 'quantity', text: 'Six stations', value: '6', mandatory: true },
      { key: 'lead_time', text: 'Delivery within 12 weeks', value: '12 weeks', mandatory: false },
    ],
    matches: [
      { product_id: 'prd_sample_1', sku: 'KS-VIS-200', score: 0.96, verdict: 'FIT', reasons: ['Range 10 m to 20 km covers 10 km', 'RS-485 Modbus RTU native', 'IP66 with marine coating', '2.4 W typical'], gaps: [] },
      { product_id: 'prd_sample_4', sku: 'KS-GW-4G', score: 0.91, verdict: 'FIT', reasons: ['LTE Cat-4 with dual SIM', 'Modbus RTU to TCP and MQTT'], gaps: ['IP65 housing: mount inside the cabinet or use the sensor enclosure'] },
      { product_id: 'prd_sample_5', sku: 'KS-PWR-SOL20', score: 0.88, verdict: 'FIT', reasons: ['20 W panel and 120 Wh battery give 5 days autonomy at under 7 W combined load'], gaps: [] },
    ],
    status: 'quoted',
  });
  s.put('design_requests', {
    id: 'dsg_sample_rwis', workspace_id: KESTREL, intake_id: null, customer: 'Highland Roads Directorate (sample customer)', subject: 'Heated visibility sensors for 12 mountain-pass sites',
    spec_text: 'Twelve heated visibility sensors for exposed pass locations, SDI-12 output preferred, operating to minus 30 C.', requirements: [], matches: [], status: 'new',
  });

  const lines = [
    { sku: 'KS-VIS-200', description: 'KS-VIS-200 visibility sensor', qty: 6, unit_price_minor: eur(2480), discount_minor: 44640, line_total_minor: 1443360 },
    { sku: 'KS-GW-4G', description: 'KS-GW-4G IoT gateway', qty: 6, unit_price_minor: eur(640), discount_minor: 11520, line_total_minor: 372480 },
    { sku: 'KS-PWR-SOL20', description: 'KS-PWR-SOL20 solar power kit', qty: 6, unit_price_minor: eur(520), discount_minor: 9360, line_total_minor: 302640 },
  ];
  s.put('quotes', { id: 'quo_sample_westbay', workspace_id: KESTREL, design_request_id: 'dsg_sample_westbay', tender_id: null, currency: 'EUR', lines, subtotal_minor: 2118480, discount_minor: 65520, tax_minor: 487250, total_minor: 2605730, valid_until: '2026-12-15T00:00:00Z', status: 'ready' });
}
