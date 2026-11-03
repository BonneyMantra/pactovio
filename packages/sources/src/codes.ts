/** Country and language code tables for TED (ISO alpha-3) and the UI (ISO alpha-2). */
export const ISO3_TO_ISO2: Record<string, string> = {
  AUT: 'AT', BEL: 'BE', BGR: 'BG', HRV: 'HR', CYP: 'CY', CZE: 'CZ', DNK: 'DK', EST: 'EE', FIN: 'FI', FRA: 'FR', DEU: 'DE', GRC: 'GR', HUN: 'HU',
  IRL: 'IE', ITA: 'IT', LVA: 'LV', LTU: 'LT', LUX: 'LU', MLT: 'MT', NLD: 'NL', POL: 'PL', PRT: 'PT', ROU: 'RO', SVK: 'SK', SVN: 'SI', ESP: 'ES',
  SWE: 'SE', NOR: 'NO', ISL: 'IS', LIE: 'LI', CHE: 'CH', GBR: 'GB', ALB: 'AL', MNE: 'ME', MKD: 'MK', SRB: 'RS', TUR: 'TR', UKR: 'UA', MDA: 'MD',
  BIH: 'BA', GEO: 'GE', ARM: 'AM', XKX: 'XK',
};
export const COUNTRY_NAMES_EN: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', CZ: 'Czechia', DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France',
  DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta',
  NL: 'Netherlands', PL: 'Poland', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden', NO: 'Norway',
  IS: 'Iceland', LI: 'Liechtenstein', CH: 'Switzerland', GB: 'United Kingdom', AL: 'Albania', ME: 'Montenegro', MK: 'North Macedonia',
  RS: 'Serbia', TR: 'Türkiye', UA: 'Ukraine', MD: 'Moldova', BA: 'Bosnia and Herzegovina', GE: 'Georgia', AM: 'Armenia', XK: 'Kosovo',
};
/** TED official-language (ISO 639-2/B upper case) -> ISO 639-1. */
export const LANG3_TO_LANG2: Record<string, string> = {
  BUL: 'bg', CES: 'cs', DAN: 'da', DEU: 'de', ELL: 'el', ENG: 'en', EST: 'et', FIN: 'fi', FRA: 'fr', GLE: 'ga', HRV: 'hr', HUN: 'hu', ITA: 'it',
  LAV: 'lv', LIT: 'lt', MLT: 'mt', NLD: 'nl', POL: 'pl', POR: 'pt', RON: 'ro', SLK: 'sk', SLV: 'sl', SPA: 'es', SWE: 'sv', NOR: 'no', ISL: 'is',
  ARA: 'ar', RUS: 'ru', ZHO: 'zh',
};
/** ISO 639-1 -> TED site language segment (ted.europa.eu/<seg>/notice/...). TED uses the same two-letter codes. */
export const TED_SITE_LANGS = new Set(Object.values(LANG3_TO_LANG2).filter((l) => !['no', 'is', 'ar', 'ru', 'zh'].includes(l)));

/** "IRL" -> "IE", "IE" -> "IE", unknown -> "". */
export function iso2(country: string): string {
  const c = country.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(c)) return c === 'UK' ? 'GB' : c;
  return ISO3_TO_ISO2[c] ?? '';
}

/** CPV 2008 divisions (first two digits) with their official English labels. */
export const CPV_DIVISIONS: Record<string, string> = {
  '03': 'Agricultural, farming, fishing, forestry and related products', '09': 'Petroleum products, fuel, electricity and other sources of energy',
  '14': 'Mining, basic metals and related products', '15': 'Food, beverages, tobacco and related products', '16': 'Agricultural machinery',
  '18': 'Clothing, footwear, luggage articles and accessories', '19': 'Leather and textile fabrics, plastic and rubber materials',
  '22': 'Printed matter and related products', '24': 'Chemical products',
  '30': 'Office and computing machinery, equipment and supplies except furniture and software packages',
  '31': 'Electrical machinery, apparatus, equipment and consumables; lighting',
  '32': 'Radio, television, communication, telecommunication and related equipment',
  '33': 'Medical equipments, pharmaceuticals and personal care products', '34': 'Transport equipment and auxiliary products to transportation',
  '35': 'Security, fire-fighting, police and defence equipment',
  '37': 'Musical instruments, sport goods, games, toys, handicraft, art materials and accessories',
  '38': 'Laboratory, optical and precision equipments (excl. glasses)',
  '39': 'Furniture (incl. office furniture), furnishings, domestic appliances (excl. lighting) and cleaning products',
  '41': 'Collected and purified water', '42': 'Industrial machinery', '43': 'Machinery for mining, quarrying, construction equipment',
  '44': 'Construction structures and materials; auxiliary products to construction (except electric apparatus)', '45': 'Construction work',
  '48': 'Software package and information systems', '50': 'Repair and maintenance services', '51': 'Installation services (except software)',
  '55': 'Hotel, restaurant and retail trade services', '60': 'Transport services (excl. Waste transport)',
  '63': 'Supporting and auxiliary transport services; travel agencies services', '64': 'Postal and telecommunications services',
  '65': 'Public utilities', '66': 'Financial and insurance services', '70': 'Real estate services',
  '71': 'Architectural, construction, engineering and inspection services', '72': 'IT services: consulting, software development, Internet and support',
  '73': 'Research and development services and related consultancy services', '75': 'Administration, defence and social security services',
  '76': 'Services related to the oil and gas industry', '77': 'Agricultural, forestry, horticultural, aquacultural and apicultural services',
  '79': 'Business services: law, marketing, consulting, recruitment, printing and security', '80': 'Education and training services',
  '85': 'Health and social work services', '90': 'Sewage, refuse, cleaning and environmental services',
  '92': 'Recreational, cultural and sporting services', '98': 'Other community, social and personal services',
};

/** CPV codes with a label: the exact label when the source supplied one, otherwise the official division label. */
export function cpvLabels(codes: string[], exact: Record<string, string> = {}): { code: string; label: string }[] {
  return codes.map((code) => ({ code, label: exact[code] ?? CPV_DIVISIONS[code.slice(0, 2)] ?? 'CPV category' }));
}
