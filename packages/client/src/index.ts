import { z } from 'zod';
import { endpoints, honoPath, type AnyEndpoint, type AgentWsMessage, AgentWsMessage as AgentWsSchema } from '@pactovio/contracts';

type Eps = typeof endpoints;
type Opt<T> = NonNullable<T> extends z.ZodType ? z.input<NonNullable<T>> : never;
type Has<T> = [NonNullable<T>] extends [never] ? false : true;

type Shape<E extends AnyEndpoint> =
  (Has<E['params']> extends true ? { params: Opt<E['params']> } : {}) &
  (Has<E['query']> extends true ? { query?: Opt<E['query']> } : {}) &
  (Has<E['body']> extends true ? { body: Opt<E['body']> } : {});

type HasRequired<S> = S extends { params: any } | { body: any } ? true : false;
type Args<E extends AnyEndpoint> = keyof Shape<E> extends never
  ? [input?: { signal?: AbortSignal }]
  : HasRequired<Shape<E>> extends true
    ? [input: Shape<E> & { signal?: AbortSignal }]
    : [input?: Shape<E> & { signal?: AbortSignal }];
type Result<E extends AnyEndpoint> = E['kind'] extends 'json' ? z.output<E['response']> : Response;

export type PactovioClient = { [K in keyof Eps]: (...a: Args<Eps[K]>) => Promise<Result<Eps[K]>> } & {
  /** Subscribe to a Server-Sent-Events endpoint (events stream or a run's steps). */
  subscribe(path: '/events/stream' | `/runs/${string}/stream`, onEvent: (e: { event: string; data: unknown }) => void, opts?: { signal?: AbortSignal }): () => void;
  /** wss/ws URL for the AgentHub socket. */
  agentWsUrl(opts?: { threadId?: string }): string;
  /** Parse one WebSocket frame from the agent. */
  parseAgentFrame(data: string): AgentWsMessage;
  readonly baseUrl: string;
};

export interface ClientOptions {
  /** Origin of the API, e.g. http://localhost:8787 or https://pactovio.pages.dev. Empty string = same origin. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** `Authorization: Bearer <key>` and use the /v1 prefix. Without it the /api session-cookie prefix is used. */
  apiKey?: string;
  /** Extra headers, e.g. { 'x-workspace-id': '...' }. */
  headers?: Record<string, string>;
  /** Validate responses with zod (default true). */
  validate?: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) {
    super(message);
  }
}

export function createClient(opts: ClientOptions): PactovioClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  const prefix = opts.apiKey ? '/v1' : '/api';
  const f = (...a: Parameters<typeof fetch>) => (opts.fetch ?? fetch)(...a);
  const validate = opts.validate ?? true;

  const url = (path: string, query?: Record<string, unknown>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) qs.set(k, String(v));
    const s = qs.toString();
    return `${base}${prefix}${path}${s ? `?${s}` : ''}`;
  };
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    ...opts.headers,
  });

  const client: Record<string, unknown> = {
    baseUrl: base,
    agentWsUrl(o?: { threadId?: string }) {
      const loc = (globalThis as { location?: { origin: string } }).location;
      const origin = base || loc?.origin || 'http://localhost';
      const u = new URL(`${prefix}/agent/ws`, origin).toString().replace(/^http/, 'ws');
      return o?.threadId ? `${u}?thread=${encodeURIComponent(o.threadId)}` : u;
    },
    parseAgentFrame: (data: string) => AgentWsSchema.parse(JSON.parse(data)),
    subscribe(path: string, onEvent: (e: { event: string; data: unknown }) => void, o?: { signal?: AbortSignal }) {
      const ctl = new AbortController();
      o?.signal?.addEventListener('abort', () => ctl.abort());
      void (async () => {
        const res = await f(url(path), { headers: { ...headers(false), accept: 'text/event-stream' }, signal: ctl.signal, credentials: 'include' } as RequestInit);
        if (!res.body) return;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (data) onEvent({ event, data: safeJson(data) });
          }
        }
      })().catch(() => undefined);
      return () => ctl.abort();
    },
  };

  for (const [key, e] of Object.entries(endpoints) as [string, AnyEndpoint][]) {
    client[key] = async (input: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal } = {}) => {
      const path = honoPath(e.path).replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(String(input.params?.[k])));
      const hasBody = input.body !== undefined && e.method !== 'GET';
      const isForm = typeof FormData !== 'undefined' && input.body instanceof FormData;
      const res = await f(url(path, input.query), {
        method: e.method,
        headers: headers(hasBody && !isForm),
        body: hasBody ? (isForm ? (input.body as FormData) : JSON.stringify(input.body)) : undefined,
        signal: input.signal,
        credentials: 'include',
      } as RequestInit);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new ApiError(res.status, err.code, err.error ?? `HTTP ${res.status}`);
      }
      if (e.kind !== 'json') return res;
      const json = await res.json();
      return validate ? e.response.parse(json) : json;
    };
  }
  return client as PactovioClient;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
