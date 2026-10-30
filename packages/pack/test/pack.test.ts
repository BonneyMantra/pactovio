import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PackText } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { makeEnv } from '../../../apps/api/test/helpers';
import { extractDocx, extractPack, extractXlsx } from '../src';
import { parseXml, textOf } from '../src/xml';
import { control, docx, pageBreak, para, row, table, xlsx, zip } from './build';

const root = resolve(__dirname, '../../../fixtures/packs/ie-teagasc-695163');
const real = existsSync(resolve(root, 'P4941_Web_Applications_TRD_LOT1.docx'));

describe('xml parser', () => {
  it('decodes entities, CDATA and ignores prefixes', () => {
    const x = parseXml('<a:r xmlns:a="u"><a:t>Q&amp;A &#233; &lt;ok&gt;</a:t><![CDATA[<raw>]]></a:r>');
    expect(textOf(x)).toBe('Q&A é <ok><raw>');
    expect(x.children[0]!.name).toBe('r');
  });
});

describe('docx text and form detection (synthetic)', () => {
  const form = docx([
    para('Tender Response Document', 'Heading1'),
    table(row('REF', 'QUESTION', 'RESPONSE'), ...['A1', 'A2', 'A3', 'A4', 'A5'].map((r) => row(r, `Describe requirement ${r}`, ''))),
    pageBreak,
    para('Section B'),
    control('Company name'),
  ].join(''));
  const contract = docx([para('Services Agreement', 'Heading1'), para('1. The Supplier shall provide the services.'), para('2. Payment within 30 days.')].join(''));

  it('splits pages at page breaks and marks empty answer cells and content controls', () => {
    const r = extractDocx(form, 'TRD.docx');
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]!.text).toContain('# Tender Response Document');
    expect(r.pages[0]!.text).toContain('| A1 | Describe requirement A1 | [[RESPONSE]] |');
    expect(r.pages[1]!.text).toContain('[[RESPONSE: Company name]]');
    expect(r.signals).toMatchObject({ emptyAnswerCells: 5, contentControls: 1, responseHeadings: 1 });
    expect(r.isForm).toBe(true);
  });
  it('does not flag a plain contract as a form', () => {
    expect(extractDocx(contract, 'Services contract.docx').isForm).toBe(false);
  });
  it('rejects a file that is not a DOCX', () => {
    expect(() => extractDocx(new TextEncoder().encode('not a zip'))).toThrow();
  });
});

describe('xlsx sheets', () => {
  it('reads shared strings and numbers, one page per sheet', () => {
    const r = extractXlsx(xlsx({ Pricing: [['Item', 'Qty'], ['Sensor', 12]], Notes: [['Valid 90 days']] }));
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]!.text).toContain('A2=Sensor | B2=12');
    expect(r.pages[1]!.text).toContain('Sheet: Notes');
  });
});

describe('extractPack in a Worker env', () => {
  let env: Env;
  let dispose: () => Promise<void>;
  beforeAll(async () => ({ env, dispose } = await makeEnv()), 60_000);
  afterAll(async () => dispose?.());

  it('unzips, extracts, stores text.json and documents rows, and is idempotent', async () => {
    const form = docx([para('Response Document', 'Heading1'), table(row('REF', 'ASK', 'ANSWER'), ...['1', '2', '3', '4'].map((r) => row(r, `Ask ${r}`, '')))].join(''));
    const bundle = zip({ 'Forms/Response form.docx': form, 'Forms/Pricing Schedule.xlsx': xlsx({ P: [['Item', 'Price']] }), 'Forms/notes.txt': new Uint8Array([65]), '__MACOSX/x.docx': form });
    await env.FILES.put('packs/tnd_t1/Pack.zip', bundle);
    await env.FILES.put('packs/tnd_t1/diagram.png', new Uint8Array([137, 80, 78, 71]));
    const input = { tenderId: 'tnd_sample_teagasc_p4941', r2Keys: ['packs/tnd_t1/Pack.zip', 'packs/tnd_t1/diagram.png'] };
    const a = await extractPack(env, input);
    expect(PackText.safeParse(a).success).toBe(true);
    expect(a.docs.map((d) => d.filename).sort()).toEqual(['Pricing Schedule.xlsx', 'Response form.docx', 'diagram.png']);
    expect(a.docs.find((d) => d.filename === 'Response form.docx')!.isForm).toBe(true);
    expect(a.docs.find((d) => d.filename === 'diagram.png')!.images).toEqual([{ page: 1, r2Key: 'packs/tnd_t1/diagram.png' }]);
    const stored = PackText.parse(await (await env.FILES.get('packs/tnd_sample_teagasc_p4941/text.json'))!.json());
    expect(stored.docs).toHaveLength(3);
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE tender_id = 'tnd_sample_teagasc_p4941' AND r2_key LIKE 'packs/tnd_t1/%'").first<{ n: number }>())!.n;
    expect(await count()).toBe(4); // zip + 2 entries + png
    await extractPack(env, input);
    expect(await count()).toBe(4);
    expect((await extractPack(env, input)).docs).toHaveLength(3);
  });

  it('requires a tender or intake id and survives an unreadable file', async () => {
    await expect(extractPack(env, { r2Keys: [] })).rejects.toThrow();
    await env.FILES.put('packs/tnd_t2/broken.pdf', new Uint8Array([1, 2, 3]));
    const out = await extractPack(env, { intakeId: 'int_sample_teagasc', r2Keys: ['packs/tnd_t2/broken.pdf'] });
    expect(out.docs[0]!.pages[0]!.text).toContain('Could not read broken.pdf');
  });

  it('reads a pasted or e-mailed request (message.txt) as text pages', async () => {
    const body = `From: Procurement <buy@harbourview-port.example>\nSubject: RFQ: 40 environmental sensors\n\nPlease quote 40 visibility sensors, IP67.\n\n${'Delivery within 8 weeks. '.repeat(300)}`;
    await env.FILES.put('intakes/int_sample_teagasc/message.txt', body);
    const out = await extractPack(env, { intakeId: 'int_sample_teagasc', r2Keys: ['intakes/int_sample_teagasc/message.txt'] });
    const doc = out.docs.find((d) => d.filename === 'message.txt')!; // merges into the intake's earlier text.json
    expect(doc.kind).toBe('email');
    expect(doc.pages.length).toBeGreaterThan(1);
    expect(doc.pages[0]!.text).toContain('40 visibility sensors');
  });
});

describe.skipIf(!real)('real Teagasc P4941 pack', () => {
  const read = (n: string) => new Uint8Array(readFileSync(resolve(root, n)));
  it('detects the three lot response forms and not the Call for Tenders', () => {
    for (const lot of [1, 2, 3]) {
      const r = extractDocx(read(`P4941_Web_Applications_TRD_LOT${lot}.docx`), `P4941_Web_Applications_TRD_LOT${lot}.docx`);
      expect(r.isForm, `lot ${lot}`).toBe(true);
      expect(r.signals.emptyAnswerCells).toBeGreaterThan(100);
      expect(r.pages.length).toBeGreaterThan(15);
    }
    expect(extractDocx(read('P4941 - CFT for Web applications_services.docx'), 'P4941 - CFT for Web applications_services.docx').isForm).toBe(false);
  });
});
