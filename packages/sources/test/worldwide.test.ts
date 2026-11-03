import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTedQuery, countryFromName, domainOfCpv, domainsFromText, fetchWorldwide, mapCfRelease, mapWorldBankNotice, poolDetail, regionOf, regionsInText,
  searchContractsFinder, searchWorldBank,
} from '../src';

const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', n), 'utf8')) as { releases?: unknown[]; procnotices?: unknown[] };

describe('UK Contracts Finder OCDS (recorded 2026-11-04)', () => {
  it('maps a tender-stage release with value, exact CPV label, contact and the notice id', () => {
    const t = mapCfRelease(fx('cf-ocds.json').releases![0]);
    expect(t).toMatchObject({ source: 'cf', source_ref: '35433066-264c-41c5-bb3c-836e971b0da5', title: 'Candidate Assessment Services', buyer: 'Ingeus',
      country: 'GB', cpv: ['79300000'], value_eur: 115000, deadline: '2026-11-10T17:00:00.000Z', published_at: '2026-11-03T15:57:56.000Z',
      url: 'https://www.contractsfinder.service.gov.uk/Notice/35433066-264c-41c5-bb3c-836e971b0da5',
      raw: { procurement_method: 'Open procedure (below threshold)', value_original: { amount: 100000, currency: 'GBP' }, value_eur_estimated: true,
        cpv_labels: { '79300000': 'Market and economic research; polling and statistics' }, contact: { contact_name: 'Julie Weaver', email: 'jweaver@ingeus.co.uk' } } });
    expect(poolDetail(t)).toMatchObject({ original_language: 'en', estimated_value: { amount_minor: 10000000, currency: 'GBP' },
      buyer: { name: 'Ingeus', country_code: 'GB', email: 'jweaver@ingeus.co.uk', phone: '02072653000' }, key_dates: { tender_deadline: '2026-11-10T17:00:00.000Z' } });
  });
  it('searches tender-stage notices since a date and keeps only active ones', async () => {
    let url = '';
    const fn = (async (u: string) => { url = u; return Response.json(fx('cf-ocds.json')); }) as typeof fetch;
    expect((await searchContractsFinder({ publishedFrom: '2026-10-21T00:00:00', fetch: fn })).length).toBe(3);
    expect(url).toBe('https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?stages=tender&limit=100&publishedFrom=2026-10-21T00%3A00%3A00');
  });
});

describe('World Bank procurement notices (recorded 2026-11-04)', () => {
  it('maps country, language, deadline day, contact and the notice text', () => {
    const fr = mapWorldBankNotice(fx('worldbank-procnotices.json').procnotices!.find((n: any) => n.id === 'OP00478103'));
    expect(fr).toMatchObject({ source: 'wb', source_ref: 'OP00478103', country: 'MA', buyer: 'Regional Agricultural Development Office Tadla', cpv: [],
      deadline: '2026-11-02T11:00:00.000Z', published_at: '2026-11-02T00:00:00.000Z', value_eur: null,
      url: 'https://projects.worldbank.org/en/projects-operations/procurement-detail/OP00478103', raw: { official_language: 'FRA', procurement_group: 'NC', deadline_local_time: true } });
    expect(fr.title).toMatch(/^mise en place d’une solution informatique/);
    expect(poolDetail(fr)).toMatchObject({ original_language: 'fr' });
    const et = mapWorldBankNotice(fx('worldbank-procnotices.json').procnotices![0]);
    expect(et).toMatchObject({ country: 'ET', raw: { contact: { email: 'derejebekeleayana@gmail.com', contact_name: 'Dereje Bekele' } } });
    expect(String(et.raw!.description)).toContain('SPECIFIC PROCUREMENT NOTICE');
    expect(String(et.raw!.description)).not.toContain('<p>');
  });
  it('asks only for bid and interest invitations, newest first', async () => {
    let url = '';
    const fn = (async (u: string) => { url = u; return Response.json(fx('worldbank-procnotices.json')); }) as typeof fetch;
    expect((await searchWorldBank({ fetch: fn })).length).toBe(5);
    expect(new URL(url).searchParams.get('notice_type_exact')).toBe('Invitation for Bids^Request for Expression of Interest^Invitation for Prequalification');
    expect(new URL(url).searchParams.get('srt')).toBe('noticedate');
  });
});

describe('worldwide pool', () => {
  it('drops the TED country clause and reports each failing source without failing the others', async () => {
    expect(buildTedQuery({ since: '2026-10-21', cpvPrefixes: ['38'], countries: [] })).toBe('publication-date>=20261021 AND (notice-type=cn-standard) AND (classification-cpv=38*)');
    const fn = (async (u: string) => {
      if (u.includes('contractsfinder')) return Response.json(fx('cf-ocds.json'));
      if (u.includes('worldbank')) return Response.json(fx('worldbank-procnotices.json'));
      return new Response('down', { status: 503 });
    }) as typeof fetch;
    const out = await fetchWorldwide({ domains: ['lab_medical'], fetch: fn });
    expect(out.failed.map((f) => f.source)).toEqual(['ted', 'fts']);
    expect(out.tenders.map((t) => t.source).sort()).toEqual([...Array(3).fill('cf'), ...Array(5).fill('wb')].sort());
  });
  it('maps regions, country names and domains', () => {
    expect([regionOf('PL'), regionOf('MY'), regionOf('ET'), regionOf('SA'), regionOf('BR')]).toEqual(['europe', 'asia', 'africa', 'middle_east', 'latin_america']);
    expect(regionsInText('Germany, Southeast Asia and the GCC')).toEqual(['middle_east', 'asia']);
    expect([countryFromName('Ethiopia'), countryFromName('Congo, Democratic Republic of'), countryFromName('England'), countryFromName('Caribbean')]).toEqual(['ET', 'CD', 'GB', '']);
    expect([domainOfCpv('38410000'), domainOfCpv('50312000'), domainOfCpv('50100000'), domainOfCpv('72000000')]).toEqual(['lab_medical', 'it_software', 'facilities_services', 'it_software']);
    expect(domainsFromText('Supply, installation and calibration of laboratory equipment')).toEqual(['lab_medical']);
  });
});
