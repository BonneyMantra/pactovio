/** Shared region and domain vocabularies for worldwide opportunities (facets, filters, relevance). */
export const REGIONS = ['europe', 'north_america', 'latin_america', 'africa', 'middle_east', 'asia', 'oceania'] as const;
export type Region = typeof REGIONS[number];
export const REGION_LABELS: Record<Region, string> = {
  europe: 'Europe', north_america: 'North America', latin_america: 'Latin America & Caribbean', africa: 'Africa', middle_east: 'Middle East',
  asia: 'Asia', oceania: 'Oceania',
};
const MEMBERS: Record<Region, string> = {
  europe: 'AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK',
  north_america: 'CA US GL BM PM',
  latin_america: 'AG AI AR AW BB BO BR BS BZ CL CO CR CU DM DO EC GD GT GY HN HT JM KN KY LC MX NI PA PE PR PY SR SV TT UY VC VE VG VI',
  africa: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW',
  middle_east: 'AE BH IL IQ IR JO KW LB OM PS QA SA SY TR YE',
  asia: 'AF AM AZ BD BN BT CN GE HK ID IN JP KG KH KP KR KZ LA LK MM MN MO MV MY NP PH PK SG TH TJ TL TM TW UZ VN',
  oceania: 'AU FJ FM KI MH NR NZ PG PW SB TO TV VU WS',
};
const REGION_OF = new Map<string, Region>(REGIONS.flatMap((r) => MEMBERS[r].split(' ').map((c) => [c, r] as const)));
export const regionOf = (iso2: string): Region | null => REGION_OF.get(iso2.toUpperCase()) ?? null;

/** Region names (and a few common words) a supplier may write in "markets", mapped to regions. */
const REGION_WORDS: [RegExp, Region][] = [
  [/\b(europe|european|eu|eea|emea)\b/i, 'europe'], [/\b(north america|usa|united states|canada)\b/i, 'north_america'],
  [/\b(latin america|south america|central america|caribbean|latam)\b/i, 'latin_america'], [/\b(africa|african|emea)\b/i, 'africa'],
  [/\b(middle east|gulf|gcc|mena|emea)\b/i, 'middle_east'], [/\b(asia|asean|apac|south asia|southeast asia|east asia)\b/i, 'asia'],
  [/\b(oceania|australia|new zealand|pacific|apac)\b/i, 'oceania'],
];
export function regionsInText(text: string): Region[] {
  return REGION_WORDS.filter(([re]) => re.test(text)).map(([, r]) => r);
}

/** Every ISO 3166 alpha-2 code the runtime can name, built once from Intl (no external data). */
let byName: Map<string, string> | null = null;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const ALIASES: Record<string, string> = {
  'congo democratic republic of': 'CD', 'congo republic of': 'CG', 'egypt arab republic of': 'EG', 'yemen republic of': 'YE', 'iran islamic republic of': 'IR',
  'lao people s democratic republic': 'LA', 'kyrgyz republic': 'KG', 'turkiye': 'TR', 'turkey': 'TR', 'gambia the': 'GM', 'bahamas the': 'BS',
  'micronesia federated states of': 'FM', 'korea republic of': 'KR', 'cote d ivoire': 'CI', 'west bank and gaza': 'PS', 'syrian arab republic': 'SY',
  'venezuela republica bolivariana de': 'VE', 'slovak republic': 'SK', 'russian federation': 'RU', 'viet nam': 'VN', 'cabo verde': 'CV', 'eswatini': 'SZ',
  'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB', 'united kingdom': 'GB', 'timor leste': 'TL', 'st lucia': 'LC',
  'st vincent and the grenadines': 'VC', 'st kitts and nevis': 'KN', 'sao tome and principe': 'ST', 'macedonia north': 'MK', 'czech republic': 'CZ',
};
export function countryFromName(name: string): string {
  const key = norm(name);
  if (!key) return '';
  if (ALIASES[key]) return ALIASES[key]!;
  if (!byName) {
    byName = new Map();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      for (const c of REGION_OF.keys()) { const n = dn.of(c); if (n && n !== c) byName.set(norm(n), c); }
    } catch { /* runtime without display names: aliases only */ }
  }
  return byName.get(key) ?? '';
}

export const DOMAINS = ['it_software', 'telecom', 'electronics_electrical', 'industrial_equipment', 'lab_medical', 'construction', 'energy_utilities',
  'transport', 'professional_services', 'facilities_services', 'goods_supplies'] as const;
export type Domain = typeof DOMAINS[number];
export const DOMAIN_LABELS: Record<Domain, string> = {
  it_software: 'IT & software', telecom: 'Telecom', electronics_electrical: 'Electronics & electrical', industrial_equipment: 'Industrial equipment',
  lab_medical: 'Laboratory & medical', construction: 'Construction & engineering', energy_utilities: 'Energy & utilities', transport: 'Transport & vehicles',
  professional_services: 'Professional services', facilities_services: 'Facilities & maintenance services', goods_supplies: 'General goods & supplies',
};
/** CPV divisions per domain (TED, Find a Tender, Contracts Finder). 503 (IT repair) is IT before the generic 50 repair division. */
export const DOMAIN_CPV: Record<Domain, string[]> = {
  it_software: ['72', '48', '30', '503'], telecom: ['32', '64'], electronics_electrical: ['31'], industrial_equipment: ['42', '43', '16'],
  lab_medical: ['38', '33'], construction: ['45', '44', '71'], energy_utilities: ['09', '65', '76', '41'], transport: ['34', '60', '63'],
  professional_services: ['79', '73', '66', '75', '80', '70'], facilities_services: ['90', '50', '51', '55', '77', '85', '92', '98'],
  goods_supplies: ['03', '14', '15', '18', '19', '22', '24', '35', '37', '39'],
};
export function domainOfCpv(code: string): Domain | null {
  let best: Domain | null = null, len = 0;
  for (const d of DOMAINS) for (const p of DOMAIN_CPV[d]) if (code.startsWith(p) && p.length > len) { best = d; len = p.length; }
  return best;
}
/** World Bank procurement groups: works, goods, consulting, non-consulting services. */
export const WB_GROUP_DOMAIN: Record<string, Domain> = { CW: 'construction', GO: 'goods_supplies', CS: 'professional_services', NC: 'facilities_services' };
/** Default domains for each supplier segment (the segment's CPV families). */
export const SEGMENT_DOMAINS: Record<'it' | 'industrial', Domain[]> = {
  it: ['it_software', 'telecom'], industrial: ['lab_medical', 'electronics_electrical', 'telecom', 'industrial_equipment'],
};

/** Keyword domains for notices without CPV codes (World Bank). English, French and Spanish stems; a hint, never a fit. */
const DOMAIN_WORDS: [Domain, RegExp][] = [
  ['it_software', /\b(software|it systems?|information systems?|computers?|laptops?|servers?|data cent(er|re)|erp|cloud|cyber ?security|logiciels?|informatique|ordinateurs?|inform[aá]tic[oa]s?)\b/i],
  ['telecom', /\b(telecom\w*|t[ée]l[ée]communication\w*|radio|fib(re|er) optic|vsat|network equipment)\b/i],
  ['electronics_electrical', /\b(electrical|electric|transformers?|generators?|cables?|solar|lighting|[ée]lectrique\w*|el[ée]ctric[oa]s?)\b/i],
  ['industrial_equipment', /\b(machinery|machines?|pumps?|valves?|compressors?|workshop equipment|industrial equipment|[ée]quipements? industriels?)\b/i],
  ['lab_medical', /\b(laborator\w*|laboratoire\w*|medical|m[ée]dic\w*|hospital\w*|h[oô]pital\w*|diagnostic\w*|calibration|microscopes?|reagents?)\b/i],
  ['construction', /\b(construction|rehabilitation|civil works|building|roads?|bridges?|travaux|obras)\b/i],
  ['energy_utilities', /\b(water supply|sanitation|energy|power plant|electricity|irrigation|[ée]nergie|agua potable)\b/i],
  ['transport', /\b(vehicles?|trucks?|motorcycles?|v[ée]hicules?|veh[ií]culos?)\b/i],
  ['professional_services', /\b(consult\w*|stud(y|ies)|audit\w*|training|technical assistance|firm|cabinet|[ée]tude\w*|consultor[ií]a)\b/i],
  ['facilities_services', /\b(cleaning|security services|maintenance|catering|nettoyage|entretien|mantenimiento)\b/i],
];
export function domainsFromText(text: string): Domain[] {
  return DOMAIN_WORDS.filter(([, re]) => re.test(text)).map(([d]) => d);
}
