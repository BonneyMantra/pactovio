import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import worker, { isApiPath, pickTarget } from '../public/_worker.js';

const svc = (name: string) => ({ name, fetch: async () => new Response(name) });

describe('Pages _worker.js router', () => {
  it('sends API prefixes to API', () => {
    for (const p of ['/api/today', '/v1/openapi.json', '/mcp', '/mcp/sse', '/webhooks/dodo', '/ics/abc.ics', '/dev/', '/api']) expect(isApiPath(p), p).toBe(true);
  });
  it('does not capture look-alike paths', () => {
    for (const p of ['/', '/apiary', '/v10/x', '/devices', '/icsx', '/tenders/1']) expect(isApiPath(p), p).toBe(false);
  });
  it('routes UI paths to WEB when bound', () => {
    const env = { API: svc('api'), WEB: svc('web') };
    expect(pickTarget('/tenders', env).name).toBe('web');
    expect(pickTarget('/api/health', env).name).toBe('api');
  });
  it('falls back to API for UI paths when WEB is unbound', async () => {
    const env = { API: svc('api') };
    expect(pickTarget('/', env).name).toBe('api');
    const res = await worker.fetch(new Request('https://pactovio.pages.dev/'), env);
    expect(await res.text()).toBe('api');
  });
  it('returns a JSON 502 when no API binding exists', async () => {
    const res = await worker.fetch(new Request('https://pactovio.pages.dev/api/health'), {});
    expect(res.status).toBe(502);
  });
});
