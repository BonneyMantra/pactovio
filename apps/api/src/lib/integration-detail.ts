import { z } from 'zod';
import type { Env } from '@pactovio/contracts/env';
import { isAdapter, pins, selections, bindingIssue } from './integration-bindings';
import { boundTool } from './integration-read';
import { connectionAvailability, integrationClient, nativeToolkit } from './integration-provider';
import { sensitive, unavailable } from './integration-input';
export async function toolkitDetail(env: Env, slug: string) {
  const toolkit = await nativeToolkit(env, slug), auth = await connectionAvailability(env, toolkit);
  let read = { availability: 'discovery_only', reason: 'no_reviewed_product_binding' } as Record<string, unknown>;
  if (isAdapter(slug) && !bindingIssue(slug)) {
    try {
      const tool = await boundTool(env, slug);
      read = { availability: 'available', adapter: slug, operation: tool.slug, version: tool.version,
        scopes: tool.scopes ?? [], selection_schema: z.toJSONSchema(selections[slug]),
        mapping_required: true, requires_active_connection: true, verification: 'schema_bound_transport_tests_only', missing_product_fields: 'Remain unresolved until explicitly supplied in preview',
        price_format: ['square'].includes(slug) ? 'minor' : 'decimal' };
    } catch { read = { availability: 'needs_verification', reason: 'reviewed_schema_unavailable_or_changed' }; }
  }
  if (bindingIssue(slug)) read = { availability: 'needs_verification', reason: bindingIssue(slug) };
  return { slug: toolkit.slug, name: toolkit.name, ...auth, catalog_import: read,
    document_import: { availability: 'not_implemented', phases: ['selected_file_retrieval', 'extraction', 'indexing'],
      reason: 'Document staging and paid extraction/index checkpoints are not implemented in this foundation.' } };
}
export const OperationsQuery = z.object({ cursor: z.string().min(1).max(4096).optional() }).strict();
const Operation = z.object({ slug: z.string().max(200), name: z.string().max(300), version: z.string().max(100),
  toolkit: z.object({ slug: z.string() }), tags: z.array(z.string().max(100)).max(100).default([]),
  input_parameters: z.object({ required: z.array(z.string()).optional(), properties: z.record(z.string(), z.unknown()).optional() }).optional(),
});
/** Read-only hints are displayed as metadata. They do not authorize execution of any operation. */
export async function toolkitOperations(env: Env, slug: string, cursor?: string) {
  await nativeToolkit(env, slug);
  try {
    const result = z.object({ items: z.array(Operation).max(100), next_cursor: z.string().max(4096).nullish() })
      .parse(await integrationClient(env).request('GET', '/tools', undefined, { toolkit_slug: slug, limit: '100', ...(cursor ? { cursor } : {}) }));
    if (result.items.some(t => t.toolkit.slug !== slug)) throw new Error('Wrong toolkit');
    return { items: result.items.map(t => ({ slug: t.slug, name: t.name, version: t.version,
      read_only_hint: t.tags.includes('readOnlyHint'), execution: isAdapter(slug) && t.slug === pins[slug].slug && t.version === pins[slug].version && !bindingIssue(slug) ? 'reviewed_binding_only' : 'discovery_only',
      required_input_fields: (t.input_parameters?.required ?? []).filter(n => !sensitive.test(n)),
      input_fields: Object.keys(t.input_parameters?.properties ?? {}).filter(n => !sensitive.test(n)).slice(0, 100),
    })), next_cursor: result.next_cursor ?? null };
  } catch { unavailable(); }
}
