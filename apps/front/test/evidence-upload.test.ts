import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser ESM upload adapter
import { validateEvidence, uploadEvidence, uploadError, EVIDENCE_MAX_BYTES } from '../public/assets/evidence-upload-api.js';
// @ts-expect-error browser ESM catalogue form
import { supportedCurrency, CATALOGUE_CURRENCIES } from '../public/assets/catalogue-form.js';
const details = { kind: 'datasheet', title: 'Router specifications', validTo: '2028-02-29' };
const file = () => new File(['Supported routing protocols and verified interface specifications.'], 'router.txt', { type: 'text/plain' });
afterEach(() => vi.unstubAllGlobals());

describe('evidence upload boundary', () => {
  it('requires exactly one nonempty supported file within the limit', () => {
    expect(validateEvidence([file()], details)).toBeNull();
    for (const files of [[], [file(), file()], [new File([], 'empty.txt')], [new File(['data'], 'archive.zip')],
      [new File([new Uint8Array(EVIDENCE_MAX_BYTES + 1)], 'large.pdf')]]) expect(validateEvidence(files, details)).toEqual(expect.any(String));
    expect(validateEvidence([new File([new Uint8Array(EVIDENCE_MAX_BYTES)], 'max.pdf')], details)).toBeNull();
  });
  it('rejects invalid evidence kinds and impossible dates before transport', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(validateEvidence([file()], { ...details, kind: 'invented' })).toContain('type');
    await expect(uploadEvidence([file()], { ...details, validTo: '2027-02-29' })).rejects.toMatchObject({ code: 'validation' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends actual multipart bytes without a JSON content-type and accepts only ready receipts', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ evidence_id: 'ev_accepted', status: 'ready' })));
    vi.stubGlobal('fetch', fetch);
    expect(await uploadEvidence([file()], details)).toEqual({ evidence_id: 'ev_accepted', status: 'ready' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/evidence'); expect(init.credentials).toBe('same-origin');
    expect(init.headers['content-type']).toBeUndefined(); expect(init.body).toBeInstanceOf(FormData);
    expect((init.body.get('file') as File).name).toBe('router.txt');
    expect(await (init.body.get('file') as File).text()).toContain('routing protocols');
    expect(init.body.get('title')).toBe(details.title); expect(init.body.get('valid_to')).toBe(details.validTo);
    fetch.mockResolvedValue(new Response(JSON.stringify({ evidence_id: 'ev_pending', status: 'processing' })));
    await expect(uploadEvidence([file()], details)).rejects.toThrow('could not be confirmed');
  });
  it('distinguishes daily budget, paused models, provider errors and unconfirmed transport', () => {
    expect(uploadError({ code: 'cap_daily', status: 429 })).toContain('daily budget');
    expect(uploadError({ code: 'models_off', status: 429 })).toContain('paused');
    expect(uploadError({ status: 429 })).toContain('Wait');
    expect(uploadError({ status: 503 })).toContain('check whether your file was saved');
    expect(uploadError(new TypeError('offline'))).toContain('still selected');
  });
});

describe('catalogue supported currency precision', () => {
  it('accepts the agreed two-decimal currency set and rejects incompatible exponents', () => {
    expect(CATALOGUE_CURRENCIES).toHaveLength(26);
    for (const code of CATALOGUE_CURRENCIES) expect(supportedCurrency(code.toLowerCase())).toBe(true);
    for (const code of ['JPY', 'KWD', 'BHD', 'OMR', 'USD2', '', 'ABC']) expect(supportedCurrency(code)).toBe(false);
  });
});
