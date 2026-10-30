/**
 * Create the Composio auth config for a provider that has no managed OAuth (docusign, xero), named pactovio-<toolkit>.
 *   DOCUSIGN_CLIENT_ID=... DOCUSIGN_CLIENT_SECRET=... [DOCUSIGN_AUTH_URL=https://account-d.docusign.com] npx tsx scripts/connector-setup.ts docusign
 *   XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... npx tsx scripts/connector-setup.ts xero
 * Credentials come from the environment only and are never printed. Needs COMPOSIO_API_KEY.
 */
import { Composio } from '../packages/connectors/src';

const which = process.argv[2];
const key = process.env.COMPOSIO_API_KEY;
if (!key || (which !== 'docusign' && which !== 'xero')) { console.error('Usage: connector-setup.ts docusign|xero (COMPOSIO_API_KEY and <PROVIDER>_CLIENT_ID/_CLIENT_SECRET in the environment)'); process.exit(2); }
const P = which.toUpperCase();
const id = process.env[`${P}_CLIENT_ID`]; const secret = process.env[`${P}_CLIENT_SECRET`];
if (!id || !secret) { console.error(`${P}_CLIENT_ID and ${P}_CLIENT_SECRET must be set`); process.exit(2); }

const c = new Composio({ COMPOSIO_API_KEY: key });
const name = `pactovio-${which}`;
const existing = await c.findAuthConfig(name);
if (existing) { console.log(`${name} already exists (${existing}); nothing to do.`); process.exit(0); }
const credentials: Record<string, string> = { client_id: id, client_secret: secret, ...(which === 'docusign' ? { full: process.env.DOCUSIGN_AUTH_URL ?? 'https://account-d.docusign.com', scopes: 'signature,impersonation' } : {}) };
const r = await c.request<{ auth_config: { id: string } }>('POST', '/auth_configs', { toolkit: { slug: which }, auth_config: { type: 'use_custom_auth', name, authScheme: 'OAUTH2', credentials } });
console.log(`Created ${name}: ${r.auth_config.id}. Add redirect URI https://backend.composio.dev/api/v1/auth-apps/add to the ${which} app, then connect from Pactovio.`);
