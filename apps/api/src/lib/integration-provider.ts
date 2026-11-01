import { Composio } from '@pactovio/connectors';
import type { Env } from '@pactovio/contracts/env';
import { z } from 'zod';
import { HttpError } from '@pactovio/contracts';
import { Slug, unavailable } from './integration-input';
/** Bound metadata/action responses before the existing REST client buffers them. */
export function integrationClient(env: Env) {
  if (!env.COMPOSIO_API_KEY) unavailable();
  return new Composio(env, async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    if (Number(response.headers.get('content-length') ?? 0) > 2_000_000) throw new Error('Response too large');
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length; if (length > 2_000_000) throw new Error('Response too large');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new Response(bytes, { status: response.status, headers: response.headers });
  });
}
const Field = z.object({ is_secret: z.boolean().optional(), required: z.boolean().optional() });
const Fields = z.object({ required: z.array(Field).default([]) });
const AuthDetail = z.object({ mode: z.string().max(80), required_scopes: z.array(z.string().max(200)).default([]),
  fields: z.object({ auth_config_creation: Fields.optional(), connected_account_initiation: Fields.optional() }).optional(),
});
const Toolkit = z.object({ slug: Slug, name: z.string().max(300), type: z.literal('native'),
  auth_schemes: z.array(z.string().max(80)).default([]),
  composio_managed_auth_schemes: z.array(z.string().max(80)).default([]),
  auth_config_details: z.array(AuthDetail).max(30).default([]), no_auth: z.boolean().default(false),
});
export type ToolkitInfo = z.infer<typeof Toolkit>;
export async function nativeToolkit(env: Env, slug: string): Promise<ToolkitInfo> {
  try {
    const toolkit = Toolkit.parse(await integrationClient(env).request('GET', `/toolkits/${encodeURIComponent(Slug.parse(slug))}`));
    if (toolkit.slug !== slug) throw new Error('Wrong toolkit');
    return toolkit;
  } catch { unavailable(); }
}
export const hostedSchemes = new Set(['OAUTH1', 'OAUTH2', 'API_KEY', 'BASIC', 'BEARER_TOKEN']);
export const isOAuthScheme = (scheme: string) => ['OAUTH1', 'OAUTH2'].includes(scheme.toUpperCase());
const Config = z.object({ id: z.string().min(1).max(200), toolkit: z.object({ slug: Slug }),
  status: z.enum(['ENABLED', 'DISABLED']), auth_scheme: z.string().max(80), is_composio_managed: z.boolean(),
  credentials: z.record(z.string(), z.unknown()).nullish(),
  shared_credentials: z.record(z.string(), z.unknown()).nullish(), shared_connection_fields: z.record(z.string(), z.unknown()).nullish(),
});
/** Read existing configs only. No credentials, shared accounts, config creation or settings changes. */
export async function existingHostedConfig(env: Env, toolkit: ToolkitInfo) {
  const client = integrationClient(env); let cursor: string | undefined; const seen = new Set<string>();
  try {
    for (let page = 0; page < 20; page++) {
      const result = z.object({ items: z.array(Config).max(200), next_cursor: z.string().max(4096).nullish() })
        .parse(await client.request('GET', '/auth_configs', undefined, { toolkit_slug: toolkit.slug, limit: '200', ...(cursor ? { cursor } : {}) }));
      const config = result.items.find(c => c.toolkit.slug === toolkit.slug && c.status === 'ENABLED'
        && hostedSchemes.has(c.auth_scheme.toUpperCase())
        && (isOAuthScheme(c.auth_scheme) || !Object.keys(c.credentials ?? {}).length)
        && !Object.keys(c.shared_credentials ?? {}).length && !Object.keys(c.shared_connection_fields ?? {}).length
        && (toolkit.auth_schemes.some(s => s.toUpperCase() === c.auth_scheme.toUpperCase()) || toolkit.auth_config_details.some(s => s.mode.toUpperCase() === c.auth_scheme.toUpperCase()))
        && (!c.is_composio_managed || toolkit.composio_managed_auth_schemes.some(s => s.toUpperCase() === c.auth_scheme.toUpperCase())));
      if (config) return config;
      if (!result.next_cursor) return null;
      if (seen.has(result.next_cursor)) throw new Error('Repeated cursor');
      seen.add(result.next_cursor); cursor = result.next_cursor;
    }
    throw new Error('Incomplete configs');
  } catch { unavailable(); }
}
export async function connectionAvailability(env: Env, toolkit: ToolkitInfo) {
  const schemes = [...new Set([...toolkit.auth_schemes, ...toolkit.auth_config_details.map(d => d.mode)])];
  const hosted = schemes.some(s => hostedSchemes.has(s.toUpperCase()));
  const config = hosted ? await existingHostedConfig(env, toolkit) : null;
  const verifier = env.COMPOSIO_CALLBACK_VERIFIER_ENABLED === 'true';
  return { auth_schemes: schemes, managed_auth_schemes: toolkit.composio_managed_auth_schemes,
    auth_requirements: toolkit.auth_config_details.map(d => ({ scheme: d.mode, required_scopes: d.required_scopes,
      configuration_field_count: d.fields?.auth_config_creation?.required.length ?? 0,
      account_field_count: d.fields?.connected_account_initiation?.required.length ?? 0 })),
    connection: { availability: hosted && config && verifier ? 'ready' : 'needs_setup',
      mode: config ? config.is_composio_managed ? 'managed_oauth' : isOAuthScheme(config.auth_scheme) ? 'configured_oauth' : 'configured_hosted_auth' : null,
      reason: !hosted ? 'hosted_scheme_not_implemented' : !config ? 'auth_config_required' : !verifier ? 'callback_verifier_required' : null },
  };
}
export const setupRequired = () => { throw new HttpError(409, 'This integration needs provider configuration before it can connect.', 'needs_setup'); };
