import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as contracts from '@pactovio/contracts';
import { endpointList, type AnyEndpoint } from '@pactovio/contracts';
import { z } from 'zod';

// Regenerates the endpoint table between the markers in docs/API.md. Run from the repo root:
//   npx tsx apps/api/scripts/gen-api-doc.ts
const named = new Map<unknown, string>(Object.entries(contracts).filter(([, v]) => v && typeof v === 'object' && '_zod' in (v as object)).map(([k, v]) => [v, k]));

const keys = (s: z.ZodType | undefined): string => {
  if (!s) return '';
  const js = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as { properties?: Record<string, unknown> };
  return Object.keys(js.properties ?? {}).map((k) => `\`${k}\``).join(', ');
};
const responseName = (e: AnyEndpoint): string => {
  if (e.kind !== 'json') return `(${e.kind})`;
  const n = named.get(e.response);
  if (n) return `\`${n}\``;
  const js = z.toJSONSchema(e.response, { target: 'draft-2020-12', unrepresentable: 'any', io: 'output' }) as { properties?: Record<string, { items?: unknown }> };
  const p = js.properties ?? {};
  return p.items ? '`{ items: Entity[] }`' : '`{ ok }`';
};

const rows = (endpointList as AnyEndpoint[]).map((e) => {
  const req = [e.params && `params ${keys(e.params)}`, e.query && `query ${keys(e.query)}`, e.body && `body ${keys(e.body)}`].filter(Boolean).join('; ') || '-';
  return `| ${e.method} | \`${e.path}\` | ${req} | ${responseName(e)} | ${e.status} | ${e.lane} | ${e.summary} |`;
});
const table = `| Method | Path (under /api or /v1) | Request | Response | Status | Owner | Summary |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}`;

const file = resolve(process.cwd(), 'docs/API.md');
const doc = readFileSync(file, 'utf8').replace(/<!--ENDPOINTS:START-->[\s\S]*<!--ENDPOINTS:END-->/, `<!--ENDPOINTS:START-->\n${table}\n<!--ENDPOINTS:END-->`);
writeFileSync(file, doc);
process.stderr.write(`docs/API.md updated (${endpointList.length} endpoints)\n`);
