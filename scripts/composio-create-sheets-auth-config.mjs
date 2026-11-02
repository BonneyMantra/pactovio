#!/usr/bin/env node
/**
 * Ensure the Pactovio Composio project has one Composio-managed Google Sheets (googlesheets) OAuth2 auth config, so the
 * universal integration flow can offer "Connect Google Sheets" (it only ever reads existing configs).
 *
 *   PACTOVIO_COMPOSIO_API_KEY=... node scripts/composio-create-sheets-auth-config.mjs           # dry run: report only
 *   PACTOVIO_COMPOSIO_API_KEY=... node scripts/composio-create-sheets-auth-config.mjs --apply   # create if missing
 *
 * Idempotent: an existing ENABLED, Composio-managed, credential-free googlesheets config is reused and nothing is written.
 * The key is read from the environment only and never printed. A DISABLED config is reported, never re-enabled or edited.
 * Production still needs the project callback verifier (/api/connectors/verifier) and COMPOSIO_CALLBACK_VERIFIER_ENABLED=true.
 */
const BASE = 'https://backend.composio.dev/api/v3.1';
const TOOLKIT = 'googlesheets';
const NAME = 'pactovio-googlesheets';
const key = process.env.PACTOVIO_COMPOSIO_API_KEY;
const apply = process.argv.includes('--apply');
const out = (line) => process.stdout.write(`${line}\n`);
const fail = (line, code = 1) => { process.stderr.write(`${line}\n`); process.exit(code); };
if (!key) fail('Set PACTOVIO_COMPOSIO_API_KEY (the Pactovio project key) in the environment.', 2);

async function api(method, path, body, query) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method, signal: AbortSignal.timeout(20000),
    headers: { 'x-api-key': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) fail(`Composio ${method} ${path} failed: HTTP ${res.status} ${json?.error?.message ?? ''}`.trim());
  return json;
}

const empty = (o) => !o || Object.keys(o).length === 0;
const toolkit = await api('GET', `/toolkits/${TOOLKIT}`);
const managed = (toolkit.composio_managed_auth_schemes ?? []).map((s) => String(s).toUpperCase());
if (!managed.includes('OAUTH2')) fail(`Composio does not offer managed OAUTH2 for ${TOOLKIT} (managed: ${managed.join(', ') || 'none'}).`);

const configs = [];
let cursor;
for (let page = 0; page < 20; page++) {
  const r = await api('GET', '/auth_configs', undefined, { toolkit_slug: TOOLKIT, limit: '200', ...(cursor ? { cursor } : {}) });
  configs.push(...(r.items ?? []).filter((c) => c?.toolkit?.slug === TOOLKIT));
  if (!r.next_cursor || r.next_cursor === cursor) break;
  cursor = r.next_cursor;
}
const usable = configs.find((c) => c.status === 'ENABLED' && c.is_composio_managed === true && String(c.auth_scheme).toUpperCase() === 'OAUTH2'
  && empty(c.shared_credentials) && empty(c.shared_connection_fields));
if (usable) { out(`Reusing existing enabled managed ${TOOLKIT} auth config ${usable.id} (${usable.name ?? 'unnamed'}). Nothing written.`); process.exit(0); }
for (const c of configs) out(`Found ${c.status ?? 'UNKNOWN'} ${TOOLKIT} config ${c.id} (managed=${c.is_composio_managed}, scheme=${c.auth_scheme}); not usable, left unchanged.`);
if (!apply) { out(`Dry run: would create Composio-managed ${TOOLKIT} auth config "${NAME}". Re-run with --apply to create it.`); process.exit(0); }

const created = await api('POST', '/auth_configs', { toolkit: { slug: TOOLKIT }, auth_config: { type: 'use_composio_managed_auth', name: NAME } });
const id = created?.auth_config?.id;
if (!id) fail('Composio did not return an auth config id; check the dashboard before retrying.');
out(`Created Composio-managed ${TOOLKIT} auth config ${id} ("${NAME}").`);
