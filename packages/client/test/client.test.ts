import { describe, expect, it } from 'vitest';
import { ApiError, createClient } from '../src';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('client', () => {
  it('builds paths, query strings and bodies per endpoint', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const c = createClient({
      baseUrl: 'http://localhost:8787/', validate: false,
      fetch: (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json({ run_id: 'run_1' }); }) as typeof fetch,
    });
    await c.startPackRun({ params: { id: 'tnd 1' }, body: { replay: true } });
    await c.listTenders({ query: { q: 'web', limit: 5 } });
    expect(calls[0]!.url).toBe('http://localhost:8787/api/tenders/tnd%201/runs');
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.init!.body).toBe('{"replay":true}');
    expect(calls[1]!.url).toBe('http://localhost:8787/api/tenders?q=web&limit=5');
  });
  it('uses /v1 and a bearer key when apiKey is set', async () => {
    let seen: { url: string; auth?: string } | undefined;
    const c = createClient({ baseUrl: 'https://x.test', apiKey: 'pk_abc', validate: false, fetch: (async (url: string, init?: RequestInit) => { seen = { url, auth: (init!.headers as Record<string, string>).authorization }; return json({}); }) as typeof fetch });
    await c.getToday();
    expect(seen).toEqual({ url: 'https://x.test/v1/today', auth: 'Bearer pk_abc' });
  });
  it('throws ApiError with the server code', async () => {
    const c = createClient({ baseUrl: '', fetch: (async () => json({ error: 'Tender not found', code: 'not_found' }, 404)) as typeof fetch });
    await expect(c.getTender({ params: { id: 'x' } })).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'Tender not found' });
    await expect(c.getTender({ params: { id: 'x' } })).rejects.toBeInstanceOf(ApiError);
  });
  it('validates responses against the contract', async () => {
    const c = createClient({ baseUrl: '', fetch: (async () => json({ ok: 'yes' })) as typeof fetch });
    await expect(c.health()).rejects.toThrow();
  });
  it('derives the agent WebSocket URL', () => {
    const c = createClient({ baseUrl: 'https://pactovio.pages.dev' });
    expect(c.agentWsUrl({ threadId: 'thr_1' })).toBe('wss://pactovio.pages.dev/api/agent/ws?thread=thr_1');
  });
});
