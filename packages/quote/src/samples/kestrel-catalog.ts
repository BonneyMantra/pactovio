/** Kestrel Sensing Ltd (Sample company, fictional) product catalogue. Prices are list prices in minor units. */
export interface CatalogItem {
  id: string;
  sku: string;
  name: string;
  family: string;
  unit: string;
  eur: number;
  inr: number;
  blurb: string;
  features: string[];
  /** [parameter, value, notes] */
  specs: [string, string, string][];
  structured: Record<string, unknown>;
}

const std: [string, string, string][] = [['Compliance', 'CE (EMC 2014/30/EU, RED 2014/53/EU where radio), RoHS 2011/65/EU', 'Declarations on request'], ['Warranty', '24 months', 'Return to Galway or Pune']];

export const CATALOG: CatalogItem[] = [
  { id: 'prd_k_vs210', sku: 'VS-210', name: 'VS-210 visibility (fog) sensor', family: 'Visibility', unit: 'each', eur: 295000, inr: 24500000,
    blurb: 'Forward-scatter visibility sensor reporting meteorological optical range (MOR) for harbours, airfields, roads and wind farms.',
    features: ['MOR 10 m to 75 km with 1-minute and 10-minute averages', 'Heated optics and hood with automatic contamination compensation', 'RS-485 Modbus RTU and SDI-12 on the same connector', 'Marine-grade coating, tested to salt mist IEC 60068-2-52'],
    specs: [['Measurement principle', 'Forward scatter, 42 degrees, infrared 880 nm', ''], ['Visibility range (MOR)', '10 m to 75 km', 'Reported in metres'], ['Accuracy', '±10% from 10 m to 10 km; ±20% from 10 km to 75 km', 'Against reference transmissometer'],
      ['Output interfaces', 'RS-485 Modbus RTU, SDI-12, 4-20 mA (optional)', 'Baud 1200 to 115200'], ['Ingress protection', 'IP67', 'IEC 60529'], ['Operating temperature', '-40 °C to +60 °C', 'With heaters enabled'],
      ['Supply voltage', '9 to 30 V DC', ''], ['Power consumption', '1.8 W typical, 9 W with heaters', 'Heaters thermostat controlled'], ['Corrosion resistance', 'Salt mist IEC 60068-2-52 severity 3', 'Marine coating standard'], ['Response time', '60 s (1-minute average)', ''], ...std],
    structured: { range_m: [10, 75000], accuracy: '±10% to 10 km', interfaces: ['RS-485 Modbus RTU', 'SDI-12'], ingress: 'IP67', temp_c: [-40, 60], supply_v: [9, 30], power_w_typ: 1.8, marine: true } },
  { id: 'prd_k_pw300', sku: 'PW-300', name: 'PW-300 present-weather sensor', family: 'Present weather', unit: 'each', eur: 485000, inr: 41000000,
    blurb: 'Combined visibility and precipitation sensor that identifies rain, drizzle, snow, hail and fog (WMO SYNOP and METAR codes).',
    features: ['Precipitation type and intensity from forward scatter and a capacitive drop sensor', 'Visibility 10 m to 20 km', 'Outputs WMO 4680 and 4677 present-weather codes'],
    specs: [['Visibility range (MOR)', '10 m to 20 km', ''], ['Precipitation intensity', '0 to 250 mm/h', 'Resolution 0.01 mm/h'], ['Precipitation types', 'Drizzle, rain, snow, hail, mixed, freezing', 'WMO 4680 / 4677'], ['Output interfaces', 'RS-485 Modbus RTU, SDI-12, RS-232', ''],
      ['Ingress protection', 'IP66', ''], ['Operating temperature', '-40 °C to +60 °C', ''], ['Supply voltage', '10 to 30 V DC', ''], ['Power consumption', '3.5 W typical, 14 W with heaters', ''], ...std],
    structured: { range_m: [10, 20000], interfaces: ['RS-485 Modbus RTU', 'SDI-12', 'RS-232'], ingress: 'IP66', temp_c: [-40, 60], power_w_typ: 3.5 } },
  { id: 'prd_k_cb12', sku: 'CB-12', name: 'CB-12 cloud-base ceilometer', family: 'Cloud', unit: 'each', eur: 1190000, inr: 99500000,
    blurb: 'Laser ceilometer measuring cloud base height and vertical visibility for airfields and wind-energy forecasting.',
    features: ['Cloud base up to 7,600 m with three layers', 'Class 1M eye-safe 905 nm laser', 'Automatic window-contamination detection and blower'],
    specs: [['Cloud base measuring range', '15 m to 7,600 m', 'Three layers reported'], ['Resolution', '5 m', ''], ['Laser', '905 nm, class 1M (IEC 60825-1)', 'Eye safe'], ['Output interfaces', 'RS-485 Modbus RTU, RS-232, Ethernet', ''], ['Ingress protection', 'IP65', ''], ['Operating temperature', '-40 °C to +60 °C', ''], ['Supply voltage', '24 V DC', ''], ['Power consumption', '14 W typical, 35 W with blower', ''], ...std],
    structured: { range_m: [15, 7600], interfaces: ['RS-485 Modbus RTU', 'RS-232', 'Ethernet'], ingress: 'IP65', power_w_typ: 14 } },
  { id: 'prd_k_dl40', sku: 'DL-40', name: 'DL-40 data logger', family: 'Loggers', unit: 'each', eur: 89000, inr: 7400000,
    blurb: 'Low-power logger for remote sensor stations: polls Modbus and SDI-12 sensors and stores data locally during backhaul outages.',
    features: ['RS-485 Modbus RTU master (up to 16 devices) and two SDI-12 buses', '180 days of 1-minute data in flash', 'Sub-1 W average draw for solar sites'],
    specs: [['Sensor inputs', 'RS-485 Modbus RTU master, 2 x SDI-12, 4 x 4-20 mA', ''], ['Logging interval', '1 s to 24 h, 1 minute default', ''], ['Storage', '180 days at 1-minute interval for 12 channels', 'Flash, wear levelled'], ['Interfaces to host', 'RS-232, USB-C, Ethernet', ''],
      ['Operating temperature', '-40 °C to +70 °C', ''], ['Supply voltage', '9 to 28 V DC', ''], ['Power consumption', '0.4 W average', ''], ['Ingress protection', 'IP20 (mount in enclosure)', ''], ...std],
    structured: { channels: 12, interfaces: ['RS-485 Modbus RTU master', 'SDI-12', '4-20 mA'], storage_days_1min: 180, power_w_typ: 0.4, temp_c: [-40, 70] } },
  { id: 'prd_k_gw4g', sku: 'GW-4G', name: 'GW-4G IoT gateway (LTE-M / 4G)', family: 'Gateways', unit: 'each', eur: 64000, inr: 5300000,
    blurb: 'Industrial gateway that bridges RS-485 Modbus RTU sensors to the cloud over 4G with LTE-M fallback and dual SIM.',
    features: ['LTE Cat-4 with LTE-M (Cat-M1) fallback, dual SIM with automatic failover', 'RS-485 Modbus RTU to Modbus TCP and MQTT 3.1.1/5 over TLS', 'Store-and-forward during backhaul loss'],
    specs: [['Cellular', 'LTE Cat-4, LTE-M (Cat-M1), NB-IoT, 2G fallback', 'Dual nano-SIM, auto failover'], ['Serial', '1 x RS-485 (Modbus RTU), 1 x RS-232', ''], ['Protocols', 'Modbus RTU/TCP, MQTT, HTTPS, SNMP', 'TLS 1.2'], ['Ingress protection', 'IP65', 'Mount in cabinet or sensor enclosure'],
      ['Operating temperature', '-40 °C to +70 °C', ''], ['Supply voltage', '9 to 36 V DC', ''], ['Power consumption', '2.0 W typical, 4.5 W peak during transmit', ''], ...std],
    structured: { backhaul: 'LTE Cat-4, LTE-M, dual SIM', interfaces: ['RS-485 Modbus RTU', 'RS-232'], protocols: ['Modbus RTU to TCP', 'MQTT', 'HTTPS'], ingress: 'IP65', power_w_typ: 2.0, temp_c: [-40, 70] } },
  { id: 'prd_k_sp60', sku: 'SP-60', name: 'SP-60 solar power kit', family: 'Power', unit: 'each', eur: 78000, inr: 6500000,
    blurb: 'Off-grid power for a sensor station: panel, MPPT controller and sealed battery sized for a 15 W continuous load.',
    features: ['60 W monocrystalline panel with tilt bracket', '100 Ah / 1.2 kWh LiFePO4 battery rated -20 °C to +60 °C with heater pad', 'Seven days autonomy at a 7 W continuous load'],
    specs: [['Panel', '60 W peak, monocrystalline', ''], ['Battery', '12.8 V, 100 Ah (1,280 Wh) LiFePO4', 'Low-temperature charge protection'], ['Autonomy', '7 days at 7 W; 3 days at 15 W', 'No sun'], ['Controller', 'MPPT 10 A, 12 V output', ''], ['Ingress protection', 'IP65 enclosure', ''], ['Operating temperature', '-30 °C to +60 °C', ''], ...std],
    structured: { panel_w: 60, battery_wh: 1280, autonomy_days_at_7w: 7, ingress: 'IP65' } },
  { id: 'prd_k_mm3', sku: 'MM-3', name: 'MM-3 mounting mast (3 m)', family: 'Mounting', unit: 'each', eur: 56000, inr: 4600000,
    blurb: 'Hot-dip galvanised tilt-over mast with 316 stainless fixings for exposed coastal and quay locations.',
    features: ['Tilt-over base for maintenance at ground level', 'Hot-dip galvanised steel, 316 stainless fixings', 'Survival wind speed 60 m/s'],
    specs: [['Height', '3.0 m', 'Other heights on request'], ['Material', 'Hot-dip galvanised steel, 316 stainless fasteners', 'ISO 1461'], ['Survival wind speed', '60 m/s', ''], ['Base', 'Tilt-over plate, 4 x M16 anchors', ''], ['Mass', '38 kg', ''], ['Corrosion resistance', 'C5-M (marine) per ISO 12944', ''], ...std],
    structured: { height_m: 3, material: 'galvanised steel, 316 stainless', wind_ms: 60, corrosion: 'C5-M' } },
  { id: 'prd_k_ck1', sku: 'CK-1', name: 'CK-1 calibration kit', family: 'Calibration', unit: 'each', eur: 135000, inr: 11200000,
    blurb: 'Traceable scatter reference plate and cleaning kit for on-site verification of VS-210 and PW-300 sensors.',
    features: ['Reference scatter plate with traceable certificate (UKAS-aligned)', 'Cleaning kit and field calibration procedure', 'Records verification to the Kestrel cloud service'],
    specs: [['Reference plate', 'Scatter equivalent 200 m MOR, ±3%', 'Calibration certificate, 12 months'], ['Compatible sensors', 'VS-210, PW-300', ''], ['Case', 'IP67 transport case', ''], ...std],
    structured: { compatible: ['VS-210', 'PW-300'], reference_mor_m: 200 } },
  { id: 'prd_k_cloud', sku: 'KC-SITE', name: 'Kestrel Cloud data service (per site per year)', family: 'Services', unit: 'site per year', eur: 42000, inr: 3500000,
    blurb: 'Hosted data service: dashboards, alerts, API and five-year retention for each monitored site.',
    features: ['Live dashboard, threshold alerts by email and SMS, REST API and MQTT feed', 'Five-year data retention, EU hosting', '99.9% monthly availability service level'],
    specs: [['Data retention', '5 years', 'Raw 1-minute data'], ['Availability SLA', '99.9% per month', 'Service credits apply'], ['Alert channels', 'Email, SMS, webhook', ''], ['Hosting', 'EU region (Dublin)', ''], ['Support', 'Business hours, 4-hour response', ''], ['Licence unit', 'One site (up to 16 sensors) per year', '']],
    structured: { retention_years: 5, sla: '99.9%', hosting: 'EU' } },
  { id: 'prd_k_install', sku: 'SVC-INSTALL', name: 'Installation and commissioning (per day)', family: 'Services', unit: 'day', eur: 115000, inr: 9500000,
    blurb: 'A Kestrel field engineer installs, wires, configures and commissions equipment on site.',
    features: ['Engineer travel within Ireland included', 'Commissioning report and as-built wiring record', 'Typical site: one station per day'],
    specs: [['Unit', 'One engineer, one day (8 hours)', ''], ['Scope', 'Mounting, wiring, configuration, commissioning test', ''], ['Coverage', 'Ireland and UK; Europe and India on request', ''], ['Documentation', 'Commissioning report, as-built record', '']],
    structured: { unit: 'engineer-day' } },
];
