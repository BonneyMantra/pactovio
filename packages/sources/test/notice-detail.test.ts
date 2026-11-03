import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cpvLabels, fetchFtsDetail, fetchTedDetail, iso2, mapFtsDetail, mapTedDetail, NoticeNotFound } from '../src';

const fx = (n: string) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', n), 'utf8')) as { notices?: unknown[]; releases?: unknown[] };

describe('TED v3 notice detail (recorded 2026-11-04)', () => {
  it('maps the Baden-Württemberg police notice: description, lot duration, criteria, buyer contact and dates', () => {
    const d = mapTedDetail(fx('ted-detail-737366-2026.json').notices![0]);
    expect(d.tender).toMatchObject({ source: 'ted', source_ref: '737366-2026', title: 'POST-PCR-Pipettier-Roboter', country: 'DEU',
      deadline: '2026-11-24T09:00:00.000Z', raw: { procedure_type: 'open', official_language: 'DEU' } });
    expect(d).toMatchObject({ original_language: 'de', procedure: 'open',
      documents_url: 'https://ausschreibungen.landbw.de/Satellite/notice/CXR6YYDY45N/documents',
      submission_url: 'https://ausschreibungen.landbw.de/Satellite/notice/CXR6YYDY45N',
      key_dates: { published_at: '2026-10-26T00:00:00.000Z', tender_deadline: '2026-11-24T09:00:00.000Z', opening_at: '2026-11-24' },
      buyer: { name: 'Präsidium Technik, Logistik, Service der Polizei Baden-Württemberg', city: 'Stuttgart', postal_code: '70372', country_code: 'DE',
        email: 'polizei.bw.vergabestelle@polizei.bwl.de', phone: '+49 7112302-0', website: 'https://pptls.polizei-bw.de/' },
      award_criteria: [{ type: 'price', name: 'Wertungspreis', weight: '40.0' }, { type: 'quality', name: 'Qualität', weight: '60.0' }] });
    expect(d.description).toMatch(/^Lieferung von 2 Stück Post-PCR-Pipettier-Roboterplattformen/);
    expect(d.lots).toEqual([expect.objectContaining({ id: 'LOT-0001', title: 'POST-PCR-Pipettier-Roboter', duration: { value: 12, unit: 'month' } })]);
    expect(d.estimated_value).toBeUndefined(); // the notice states no value, so none is shown
  });
  it('keeps both Polish lots and omits fields the notice does not state', () => {
    const d = mapTedDetail(fx('ted-detail-722700-2026.json').notices![0]);
    expect(d.original_language).toBe('pl');
    expect(d.lots.map((l) => l.id)).toEqual(['LOT-0001', 'LOT-0002']);
    expect(d.lots[1]).toMatchObject({ duration: { value: 15, unit: 'week' } });
    expect(d.buyer).toMatchObject({ city: 'Wrocław', email: 'dzial_zakupow@intibs.pl', country_code: 'PL' });
    expect(d.award_criteria).toEqual([{ type: 'price', weight: '100' }]);
    expect('participation_deadline' in d.key_dates).toBe(false);
  });
  it('queries TED by publication number with the detail fields and reports a missing notice', async () => {
    let sent: any;
    const fn = (async (_: unknown, init?: RequestInit) => { sent = JSON.parse(String(init!.body)); return Response.json(fx('ted-detail-737366-2026.json')); }) as typeof fetch;
    expect((await fetchTedDetail('737366-2026', fn)).tender.source_ref).toBe('737366-2026');
    expect(sent).toMatchObject({ query: 'publication-number=737366-2026', limit: 1 });
    expect(sent.fields).toEqual(expect.arrayContaining(['description-proc', 'award-criterion-type-lot', 'buyer-email', 'procedure-type']));
    const empty = (async () => Response.json({ notices: [] })) as typeof fetch;
    await expect(fetchTedDetail('999999-2026', empty)).rejects.toBeInstanceOf(NoticeNotFound);
  });
});

describe('Find a Tender OCDS release detail (recorded 2026-11-04)', () => {
  it('maps buyer contact, value in GBP, criteria, lot duration and exact CPV labels', async () => {
    const pkg = fx('fts-detail-104375-2026.json');
    const d = mapFtsDetail(pkg.releases![0]);
    expect(d.tender).toMatchObject({ source: 'fts', source_ref: '104375-2026', title: 'PME Opportunity for NDP Assessments', country: 'GB' });
    expect(d).toMatchObject({ original_language: 'en', estimated_value: { amount_minor: 500000000, currency: 'GBP' }, procedure: 'Restricted procedure',
      submission_url: 'https://atamis-1928.my.site.com/s/Welcome', key_dates: { tender_deadline: '2026-11-16T17:00:00.000Z' },
      buyer: { name: 'University Hospitals Birmingham NHS Foundation Trust', city: 'Birmingham', postal_code: 'B15 2WB', country_code: 'GB',
        email: 'bethan.davies@uhb.nhs.uk', contact_name: 'Bethan Davies', website: 'https://www.uhb.nhs.uk/' },
      award_criteria: [{ type: 'price' }], exact_cpv_labels: { '85141000': 'Services provided by medical personnel' } });
    expect(d.lots[0]).toMatchObject({ id: '1', duration: { value: 1080, unit: 'day' } });
    let url = '';
    const fn = (async (u: string) => { url = String(u); return Response.json(pkg); }) as typeof fetch;
    expect((await fetchFtsDetail('104375-2026', fn)).tender.source_ref).toBe('104375-2026');
    expect(url).toBe('https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages/104375-2026');
    await expect(fetchFtsDetail('1-2026', (async () => new Response('', { status: 404 })) as typeof fetch)).rejects.toBeInstanceOf(NoticeNotFound);
  });
});

describe('codes', () => {
  it('converts TED alpha-3 countries and labels CPV codes honestly', () => {
    expect([iso2('IRL'), iso2('pl'), iso2('UK'), iso2('ZZZ')]).toEqual(['IE', 'PL', 'GB', '']);
    expect(cpvLabels(['38410000', '85141000'], { '85141000': 'Services provided by medical personnel' })).toEqual([
      { code: '38410000', label: 'Laboratory, optical and precision equipments (excl. glasses)' },
      { code: '85141000', label: 'Services provided by medical personnel' }]);
  });
});
