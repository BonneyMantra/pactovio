import { createHash } from 'node:crypto';
import { HttpError } from '@pactovio/contracts';

/** Composio REST v3.1 (https://docs.composio.dev/reference). Thin, fetch-injectable client: no SDK, runs in Workers and Node. */
export const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3.1';

export interface ComposioKeyEnv {
  COMPOSIO_API_KEY?: string;
}

export class ComposioError extends Error {
  constructor(public status: number, message: string, public slug?: string) {
    super(message);
    this.name = 'ComposioError';
  }
}

export interface ToolResult {
  successful: boolean;
  data: unknown;
  error: string | null;
  logId?: string;
}

export interface ConnectedAccountInfo {
  id: string;
  toolkit: string;
  status: string;
  userId: string;
  label: string | null;
  createdAt: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export class Composio {
  private fetchImpl: typeof fetch;

  /** The global `fetch` must be called unbound in Workers: storing it as a property would call it with `this` = this client. */
  constructor(private env: ComposioKeyEnv, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private key(): string {
    if (!this.env.COMPOSIO_API_KEY) throw new HttpError(500, 'COMPOSIO_API_KEY is not configured', 'internal');
    return this.env.COMPOSIO_API_KEY;
  }

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, query?: Record<string, string | string[] | undefined>): Promise<T> {
    const url = new URL(COMPOSIO_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: { 'x-api-key': this.key(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string; slug?: string };
      throw new ComposioError(res.status, err.message ?? `Composio ${method} ${path} failed (${res.status})`, err.slug);
    }
    return json as T;
  }

  /** Execute one tool as a connected account. Never throws on a failed tool run: check `successful`. */
  async executeTool(slug: string, args: Record<string, unknown>, who: { connectedAccountId: string; userId?: string }): Promise<ToolResult> {
    try {
      const r = await this.request<{ data?: unknown; error?: string | null; successful?: boolean; log_id?: string }>(
        'POST', `/tools/execute/${encodeURIComponent(slug)}`,
        { connected_account_id: who.connectedAccountId, ...(who.userId ? { user_id: who.userId } : {}), arguments: args },
      );
      return { successful: r.successful === true, data: r.data ?? null, error: r.error ?? null, logId: r.log_id };
    } catch (e) {
      if (e instanceof ComposioError) return { successful: false, data: null, error: `${e.status}: ${e.message}` };
      throw e;
    }
  }

  /** Authenticated raw provider call (for endpoints no tool covers, e.g. DocuSign envelopes). */
  async proxy(who: { connectedAccountId: string; userId?: string }, req: { endpoint: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; query?: Record<string, string> }): Promise<{ status: number; data: unknown }> {
    const r = await this.request<{ status?: number; data?: unknown }>('POST', '/tools/execute/proxy', {
      connected_account_id: who.connectedAccountId,
      ...(who.userId ? { user_id: who.userId } : {}),
      endpoint: req.endpoint,
      method: req.method,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(req.query ? { parameters: Object.entries(req.query).map(([name, value]) => ({ name, value, type: 'query' })) } : {}),
    });
    return { status: r.status ?? 0, data: r.data ?? null };
  }

  /** Two-step file staging: presigned URL, PUT the bytes, return the reference a `file_uploadable` tool input takes. */
  async stageFile(f: { toolkit: string; tool: string; filename: string; mimetype: string; bytes: Uint8Array }): Promise<{ name: string; mimetype: string; s3key: string }> {
    const md5 = createHash('md5').update(f.bytes).digest('hex');
    const r = await this.request<{ key: string; new_presigned_url: string; metadata?: { storage_backend?: string } }>('POST', '/files/upload/request', {
      toolkit_slug: f.toolkit, tool_slug: f.tool, filename: f.filename, mimetype: f.mimetype, md5,
    });
    const put = await this.fetchImpl(r.new_presigned_url, {
      method: 'PUT',
      headers: { 'content-type': f.mimetype, ...(r.metadata?.storage_backend === 'azure_blob_storage' ? { 'x-ms-blob-type': 'BlockBlob' } : {}) },
      body: f.bytes,
    });
    if (!put.ok) throw new ComposioError(put.status, `Staging ${f.filename} failed (${put.status})`);
    return { name: f.filename, mimetype: f.mimetype, s3key: r.key };
  }

  // ---- auth configs and connected accounts ----

  async findAuthConfig(name: string): Promise<string | null> {
    const r = await this.request<{ items?: { id: string; name: string; status?: string }[] }>('GET', '/auth_configs', undefined, { limit: '100' });
    return r.items?.find((i) => i.name === name && i.status !== 'DISABLED')?.id ?? null;
  }

  async createManagedAuthConfig(toolkit: string, name: string): Promise<string> {
    const r = await this.request<{ auth_config: { id: string } }>('POST', '/auth_configs', { toolkit: { slug: toolkit }, auth_config: { name, type: 'use_composio_managed_auth' } });
    return r.auth_config.id;
  }

  async createLink(p: { authConfigId: string; userId: string; callbackUrl: string; alias?: string }): Promise<{ redirectUrl: string; connectedAccountId: string; expiresAt: string | null }> {
    const r = await this.request<{ redirect_url: string; connected_account_id: string; expires_at?: string }>('POST', '/connected_accounts/link', {
      auth_config_id: p.authConfigId, user_id: p.userId, callback_url: p.callbackUrl, ...(p.alias ? { alias: p.alias } : {}),
    });
    return { redirectUrl: r.redirect_url, connectedAccountId: r.connected_account_id, expiresAt: r.expires_at ?? null };
  }

  private mapAccount(i: Record<string, unknown>): ConnectedAccountInfo {
    const state = ((i.state as Record<string, unknown> | undefined)?.val ?? {}) as Record<string, unknown>;
    return {
      id: String(i.id), toolkit: String((i.toolkit as { slug?: string } | undefined)?.slug ?? ''), status: String(i.status ?? ''),
      userId: String(i.user_id ?? ''), label: str(state.displayName) ?? str(i.alias), createdAt: str(i.created_at),
    };
  }

  async completeAuth(userId: string, sessionUri: string): Promise<{ connected_account_id: string; toolkit_slug: string }> {
    return this.request('POST', '/connected_accounts/complete_auth', { user_id: userId, session_uri: sessionUri });
  }

  async getConnectedAccount(id: string): Promise<ConnectedAccountInfo> {
    return this.mapAccount(await this.request('GET', `/connected_accounts/${encodeURIComponent(id)}`));
  }

  async listConnectedAccounts(q: { userIds?: string[]; toolkits?: string[]; statuses?: string[] }): Promise<ConnectedAccountInfo[]> {
    const r = await this.request<{ items?: Record<string, unknown>[] }>('GET', '/connected_accounts', undefined, {
      user_ids: q.userIds, toolkit_slugs: q.toolkits, statuses: q.statuses, limit: '100', order_by: 'created_at', order_direction: 'desc',
    });
    return (r.items ?? []).map((i) => this.mapAccount(i));
  }

  async deleteConnectedAccount(id: string): Promise<void> {
    await this.request('DELETE', `/connected_accounts/${encodeURIComponent(id)}`);
  }

  // ---- triggers ----

  async upsertTrigger(slug: string, p: { userId: string; connectedAccountId: string; config?: Record<string, unknown> }): Promise<string> {
    const r = await this.request<{ trigger_id?: string; id?: string }>('POST', `/trigger_instances/${encodeURIComponent(slug)}/upsert`, {
      user_id: p.userId, connected_account_id: p.connectedAccountId, trigger_config: p.config ?? {},
    });
    const id = r.trigger_id ?? r.id;
    if (!id) throw new ComposioError(502, `Composio did not return a trigger id for ${slug}`);
    return id;
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    await this.request('DELETE', `/trigger_instances/manage/${encodeURIComponent(triggerId)}`);
  }
}
