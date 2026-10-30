import { z } from 'zod';
import { endpointList } from './endpoints';
import type { AnyEndpoint } from './endpoint';

type Obj = Record<string, any>;

function schemaOf(s: z.ZodType): Obj {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as Obj;
  delete j.$schema;
  return j;
}

function paramsOf(where: 'path' | 'query', s: z.ZodType | undefined): Obj[] {
  if (!s) return [];
  const js = schemaOf(s);
  const required = new Set<string>(js.required ?? []);
  return Object.entries<Obj>(js.properties ?? {}).map(([name, schema]) => ({
    name, in: where, required: where === 'path' ? true : required.has(name), schema,
  }));
}

/** OpenAPI 3.1 document derived from the endpoint registry. Served at /v1/openapi.json. */
export function buildOpenApi(opts: { title?: string; version?: string; servers?: string[]; prefix?: string } = {}): Obj {
  const prefix = opts.prefix ?? '/v1';
  const paths: Obj = {};
  for (const e of endpointList as AnyEndpoint[]) {
    const p = prefix + e.path;
    const json = e.kind === 'json';
    const content = (s: z.ZodType) => ({ 'application/json': { schema: schemaOf(s) } });
    const op: Obj = {
      operationId: e.id,
      tags: [e.tag],
      summary: e.summary,
      'x-pactovio-status': e.status,
      'x-pactovio-lane': e.lane,
      parameters: [...paramsOf('path', e.params), ...paramsOf('query', e.query)],
      responses: {
        '200': json
          ? { description: 'OK', content: content(e.response) }
          : { description: e.kind === 'sse' ? 'text/event-stream' : e.kind === 'ws' ? 'WebSocket upgrade' : 'File' },
        '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
        '501': { description: 'Not implemented yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      },
    };
    if (!e.public) op.security = [{ apiKey: [] }];
    if (e.body) op.requestBody = { required: true, content: content(e.body) };
    paths[p] = { ...(paths[p] ?? {}), [e.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: { title: opts.title ?? 'Pactovio API', version: opts.version ?? '0.1.0', description: 'Pre-sales engine for technical B2B suppliers. snake_case JSON. Money in integer minor units (tender value_eur is whole euros).' },
    servers: (opts.servers ?? []).map((url) => ({ url })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: '`Authorization: Bearer pk_...` for /v1. The /api prefix uses the pv_s session cookie.' } },
      schemas: { ErrorBody: schemaOf(z.object({ error: z.string(), code: z.string().optional() })) },
    },
  };
}
