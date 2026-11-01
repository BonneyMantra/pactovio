import { fromRow } from '@pactovio/contracts';

export interface Call { tool: string; args: Record<string, any>; who: { connected_account_id?: string; user_id?: string } } // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (args: Record<string, any>) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A Composio REST v3.1 stand-in for unit tests. Tool handlers return the `data` of a successful execution (response shapes follow
 * Composio's documented `response_data` wrapping and the providers' own API formats). Nothing here talks to the network.
 */
export function fakeComposio(handlers: Record<string, Handler> = {}, opts: { verifiedAccount?: { connected_account_id: string; toolkit_slug: string }; failTools?: Record<string, string>; accounts?: Record<string, unknown>[]; proxy?: (req: Record<string, any>) => { status: number; data: unknown } } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: Call[] = [];
  const log: string[] = [];
  const staged: { filename: string; bytes: number }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (url.hostname === 's3.fake') { staged.push({ filename: url.pathname, bytes: (init?.body as Uint8Array).length }); return new Response('', { status: 200 }); }
    const path = url.pathname.replace('/api/v3.1', '');
    log.push(`${method} ${path}`);
    if (!(init?.headers as Record<string, string> | undefined)?.['x-api-key']) return json({ error: { message: 'no key', code: 401, slug: 'x', status: 401 } }, 401);
    if (method === 'POST' && path === '/tools/execute/proxy') { const r = opts.proxy?.(body!) ?? { status: 200, data: {} }; calls.push({ tool: `proxy ${body!.method} ${body!.endpoint}`, args: body!, who: body! }); return json(r); }
    if (method === 'POST' && path.startsWith('/tools/execute/')) {
      const tool = decodeURIComponent(path.slice('/tools/execute/'.length));
      calls.push({ tool, args: body!.arguments, who: body! });
      if (opts.failTools?.[tool]) return json({ data: {}, error: opts.failTools[tool], successful: false });
      return json({ data: handlers[tool]?.(body!.arguments) ?? {}, error: null, successful: true, log_id: 'log_test' });
    }
    if (method === 'POST' && path === '/files/upload/request') return json({ id: 'req_file_1', key: `projects/pr_1/requests/${body!.toolkit_slug}/${body!.filename}`, new_presigned_url: `https://s3.fake/${body!.filename}`, metadata: { storage_backend: 's3' } });
    if (method === 'GET' && path === '/auth_configs') return json({ items: [{ id: 'ac_other', name: 'other-product-xero', status: 'ENABLED' }] });
    if (method === 'POST' && path === '/auth_configs') return json({ toolkit: { slug: body!.toolkit.slug }, auth_config: { id: `ac_${body!.toolkit.slug}`, is_composio_managed: true } }, 201);
    if (method === 'POST' && path === '/connected_accounts/link') return json({ link_token: 'lk_1', redirect_url: 'https://connect.composio.dev/link/lk_1', expires_at: '2026-10-30T05:00:00Z', connected_account_id: `ca_new_${body!.auth_config_id}` });
    if (method === 'POST' && path === '/connected_accounts/complete_auth') return json(opts.verifiedAccount ?? {}, opts.verifiedAccount ? 200 : 400);
    if (method === 'GET' && path === '/connected_accounts') return json({ items: opts.accounts ?? [], next_cursor: null });
    if (method === 'GET' && path.startsWith('/connected_accounts/')) { const id = path.split('/').pop(); const a = (opts.accounts ?? []).find((x) => x.id === id) ?? { id, status: 'INITIATED', toolkit: { slug: 'slack' }, user_id: 'pactovio-demo' }; return json(a); }
    if (method === 'DELETE' && path.startsWith('/connected_accounts/')) return json({ success: true });
    if (method === 'POST' && path.startsWith('/trigger_instances/')) return json({ trigger_id: `ti_${path.split('/')[2]}` });
    if (method === 'DELETE' && path.startsWith('/trigger_instances/manage/')) return json({ status: 'success' });
    return json({ error: { message: `fake composio: no route ${method} ${path}`, code: 404, slug: 'nf', status: 404 } }, 404);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, log, staged, called: (tool: string) => calls.filter((c) => c.tool === tool) };
}

export const row = <T>(r: Record<string, unknown>) => fromRow<T>(r);
