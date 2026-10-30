/**
 * Refresh test/fixtures/tool-schemas.json: the live Composio input schema of every tool the provider modules call.
 *   npx tsx packages/connectors/scripts/snapshot-tool-schemas.ts   (needs COMPOSIO_API_KEY in the environment)
 * Read-only: one GET /tools page per toolkit. The unit tests validate every built tool call against this snapshot.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const slugs = new Set<string>();
for (const f of readdirSync(join(root, 'src/providers'))) {
  for (const m of readFileSync(join(root, 'src/providers', f), 'utf8').matchAll(/'([A-Z][A-Z0-9]+_[A-Z0-9_]+)'/g)) slugs.add(m[1]!);
}
const key = process.env.COMPOSIO_API_KEY;
if (!key) throw new Error('COMPOSIO_API_KEY is not set');

const out: Record<string, unknown> = {};
for (const toolkit of new Set([...slugs].map((s) => s.split('_')[0]!.toLowerCase().replace('microsoft', 'microsoft_teams')))) {
  let cursor: string | undefined;
  do {
    const url = new URL('https://backend.composio.dev/api/v3.1/tools');
    url.searchParams.set('toolkit_slug', toolkit); url.searchParams.set('limit', '1000'); url.searchParams.set('toolkit_versions', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = (await (await fetch(url, { headers: { 'x-api-key': key } })).json()) as { items: { slug: string; input_parameters: unknown }[]; next_cursor?: string };
    for (const t of page.items) if (slugs.has(t.slug)) out[t.slug] = t.input_parameters;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
}
const missing = [...slugs].filter((s) => !(s in out));
if (missing.length) console.error('Not found in Composio:', missing.join(', '));
writeFileSync(join(root, 'test/fixtures/tool-schemas.json'), `${JSON.stringify(out, null, 1)}\n`);
