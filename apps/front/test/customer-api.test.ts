import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser ESM shared client
import { api } from '../public/assets/ui.js';
// @ts-expect-error browser ESM customer contract
import { session, requestCode, verifyCode, saveCompany, connectorDestination } from '../public/assets/customer-api.js';

// @ts-expect-error browser ESM decimal conversion
import { priceToMinor, minorToPrice } from '../public/assets/catalogue-form.js';

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('customer access API boundaries', () => {
  it('does not convert an unauthenticated session into a demo workspace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'Sign in', code: 'unauthorized' }, 401)));
    await expect(session()).rejects.toMatchObject({ status: 401 });
  });
  it('rejects legacy sessions and sample workspaces', async () => {
    for (const value of [{ workspace_id: 'demo' }, { authenticated: true, user: { id: 'u' }, workspace_id: 'w', workspace: { sample: 1 } }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)));
      await expect(session()).rejects.toThrow('private workspace');
    }
  });
  it('sends exact email-code and company contracts with same-origin credentials', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({ ok: true })));
    vi.stubGlobal('fetch', fetch);
    await requestCode('mira@example.test'); await verifyCode('mira@example.test', '127456'); await saveCompany({ name: 'Meridian Systems' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/code/request', '/api/auth/code/verify', '/api/onboarding']);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ email: 'mira@example.test', code: '127456' });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ company: { name: 'Meridian Systems' } });
    expect(fetch.mock.calls.every(([, init]) => init.credentials === 'same-origin')).toBe(true);
  });
  it('invalidates private UI when a protected request returns 401', async () => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'Expired' }, 401)));
    await expect(api('/onboarding')).rejects.toMatchObject({ status: 401 });
    expect(dispatchEvent.mock.calls[0][0].type).toBe('pv:session-expired');
  });
  it('accepts provider HTTPS and the allowed relative app return only', () => {
    expect(connectorDestination('/app#/onboarding')).toBe('/app#/onboarding');
    expect(connectorDestination('https://connect.composio.dev/link')).toBe('https://connect.composio.dev/link');
    for (const url of ['javascript:alert(1)', '//elsewhere.example', '/app-malicious', null]) expect(() => connectorDestination(url)).toThrow();
  });
  it('keeps invalid OTP errors in auth and exposes retry-after recovery', async () => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Wait', code: 'rate_limited' }), { status: 429, headers: { 'retry-after': '90' } })));
    await expect(requestCode('mira@example.test')).rejects.toMatchObject({ status: 429, retryAfter: 90 });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe('customer catalogue price precision', () => {
  it('preserves exact minor units and rejects ambiguous prices', () => {
    expect(priceToMinor('19.99')).toBe(1999);
    expect(priceToMinor('0.29')).toBe(29);
    expect(priceToMinor('10000000000.00')).toBe(1e12);
    for (const value of ['1.005', '-1', '1,000', '1e3', '10000000000.01', '']) expect(priceToMinor(value)).toBeNull();
    expect(minorToPrice(100001)).toBe('1000.01');
  });
});
