import type { z } from 'zod';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type Lane =
  | 'foundation' | 'sources' | 'pack' | 'engine' | 'quote' | 'connectors' | 'billing' | 'agent' | 'audit';
/** live = real data path; sample = served from seeded rows until the owning lane replaces them; stub = 501 not_implemented */
export type EndpointStatus = 'live' | 'sample' | 'stub';
/** json = typed JSON; sse = text/event-stream; binary = file download; ws = WebSocket upgrade; multipart = file upload body */
export type EndpointKind = 'json' | 'sse' | 'binary' | 'ws' | 'multipart';

export interface Endpoint<
  P extends z.ZodType | undefined = z.ZodType | undefined,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  R extends z.ZodType = z.ZodType,
> {
  id: string;
  method: Method;
  /** OpenAPI-style path relative to the /api or /v1 prefix, e.g. `/tenders/{id}`. */
  path: string;
  tag: string;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  status: EndpointStatus;
  lane: Lane;
  kind: EndpointKind;
  /** Public endpoints need neither session nor API key. */
  public?: boolean;
}

export function defineEndpoint<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  R extends z.ZodType = z.ZodType,
>(e: Omit<Endpoint<P, Q, B, R>, 'kind'> & { kind?: EndpointKind }): Endpoint<P, Q, B, R> {
  return { kind: 'json', ...e } as Endpoint<P, Q, B, R>;
}

export type AnyEndpoint = Endpoint<any, any, any, any>;

/** `/tenders/{id}/matrix` -> `/tenders/:id/matrix` (Hono). */
export const honoPath = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');
