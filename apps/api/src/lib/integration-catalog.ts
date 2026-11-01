import { z } from 'zod';
import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { Composio, PROVIDERS } from '@pactovio/connectors';

const KEY = 'integrations:public-native-catalog:v1';
const TTL = 900;
export const CatalogQuery = z.object({
  search: z.string().trim().max(100).default(''),
  category: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
}).strict();
const Toolkit = z.object({
  slug: z.string().regex(/^[a-z0-9_-]+$/i).max(160), name: z.string().min(1).max(300),
  auth_schemes: z.array(z.string().max(80)).default([]),
  composio_managed_auth_schemes: z.array(z.string().max(80)).default([]),
  no_auth: z.boolean().optional(),
  meta: z.object({ description: z.string().max(12000).default(''), logo: z.string().max(4096).nullish(),
    categories: z.array(z.object({ name: z.string().max(160) })).default([]),
    tools_count: z.number().int().nonnegative().optional(),
  }).default({ description: '', categories: [] }),
});
const Page = z.object({ items: z.array(Toolkit).max(1000), next_cursor: z.string().max(4096).nullish() });

function normalize(item: z.infer<typeof Toolkit>) {
  const existing = PROVIDERS.find(p => p.toolkit === item.slug && !p.sharesAccountWith);
  let logo: string | null = null;
  try { const url = new URL(item.meta.logo || ''); if (url.protocol === 'https:' && !url.username && !url.password) logo = url.href; } catch { /* no logo */ }
  return { slug: item.slug, name: item.name, description: item.meta.description, logo,
    categories: item.meta.categories.map(c => c.name), auth_schemes: item.auth_schemes,
    setup: item.no_auth ? 'no_auth' : item.composio_managed_auth_schemes.length ? 'managed_auth' : 'own_credentials',
    connection_provider: existing?.provider ?? null,
    // Discovery never implies an inbound product importer or an authorized account.
    catalog_import: false as const,
  };
}
const Snapshot = z.object({ retrieved_at: z.iso.datetime(), items: z.array(Toolkit).max(20000) });

async function snapshot(env: Env) {
  if (!env.COMPOSIO_API_KEY) throw new HttpError(503, 'Integration discovery is not configured yet', 'integration_unavailable');
  try {
    const cached = await env.CACHE.get(KEY, 'json');
    const parsed = Snapshot.safeParse(cached);
    if (parsed.success && Date.now() - Date.parse(parsed.data.retrieved_at) < TTL * 1000) return parsed.data;
  } catch { /* a cache failure must not prevent live discovery */ }
  try {
    const client = new Composio(env), items: z.infer<typeof Toolkit>[] = [], cursors = new Set<string>(), slugs = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = Page.parse(await client.request('GET', '/toolkits', undefined,
        { type: 'native', limit: '1000', sort_by: 'alphabetically', ...(cursor ? { cursor } : {}) }));
      for (const item of result.items) {
        if (slugs.has(item.slug)) throw new Error('Repeated toolkit');
        slugs.add(item.slug); items.push(item);
      }
      if (!result.next_cursor) {
        const value = { retrieved_at: new Date().toISOString(), items };
        try { await env.CACHE.put(KEY, JSON.stringify(value), { expirationTtl: TTL }); } catch { /* live result is usable */ }
        return value;
      }
      if (cursors.has(result.next_cursor)) throw new Error('Repeated cursor');
      cursors.add(result.next_cursor); cursor = result.next_cursor;
    }
    throw new Error('Incomplete catalogue');
  } catch { throw new HttpError(503, 'Could not load available integrations. Please try again.', 'integration_unavailable'); }
}

export async function integrationCatalog(env: Env, query: z.infer<typeof CatalogQuery>) {
  const value = await snapshot(env), search = query.search.toLocaleLowerCase(), category = query.category.toLocaleLowerCase();
  const items = value.items.map(normalize);
  const categories = [...new Set(items.flatMap(i => i.categories))].sort((a, b) => a.localeCompare(b));
  const matching = items.filter(i => (!category || i.categories.some(c => c.toLocaleLowerCase() === category))
    && (!search || `${i.name} ${i.slug} ${i.description}`.toLocaleLowerCase().includes(search)));
  return { items: matching.slice(query.offset, query.offset + query.limit), total: matching.length,
    catalog_total: items.length, categories, retrieved_at: value.retrieved_at,
    next_offset: query.offset + query.limit < matching.length ? query.offset + query.limit : null };
}
