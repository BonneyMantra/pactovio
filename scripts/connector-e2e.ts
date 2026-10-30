/**
 * Connector end-to-end check against the LIVE accounts connected in Composio.
 *
 *   set -a; source apps/api/.env.local; set +a        # COMPOSIO_API_KEY (vault: inject.sh get COMPOSIO_API_KEY --dir apps/api)
 *   npx tsx scripts/connector-e2e.ts all              # every connected provider
 *   npx tsx scripts/connector-e2e.ts slack hubspot    # some
 *   npx tsx scripts/connector-e2e.ts gmail --api https://pactovio.pages.dev   # + email intake round trip (needs PACTOVIO_API_KEY=pk_...)
 *
 * For each CONNECTED provider (ACTIVE Composio account of user `pactovio-demo`): performs the real action, reads the object back through
 * Composio, prints PASS/FAIL with the external id and link (never a secret), then cleans up where the provider's API allows.
 * Providers that are not connected print SKIP with the exact connect steps. Exit code 1 if any connected provider FAILED.
 *
 * Gmail and Outlook additionally: send a fixture design-request email from the mailbox to ITSELF (lane C fixture), wait for the Composio
 * trigger to reach the deployed API (`--api`), and assert an intake was classified `design`. Replies are drafts only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '@pactovio/contracts/env';
import { Composio, exerciseDef, makeCtx, PROVIDER_ACTIONS, PROVIDERS, SAMPLE_USER_ID, type ActionOutput } from '../packages/connectors/src';
import type { ConnectorRow } from '../packages/connectors/src/store';

const PRIMARY: Record<string, string> = {
  gmail: 'create_draft', outlook: 'create_draft', slack: 'post_message', microsoft_teams: 'post_message', hubspot: 'create_deal', salesforce: 'create_opportunity',
  googledrive: 'upload_file', dropbox: 'upload_file', googlecalendar: 'create_event', outlook_calendar: 'create_event', jira: 'create_task', asana: 'create_task',
  docusign: 'send_for_signature', quickbooks: 'create_estimate', xero: 'create_estimate',
};

const CONNECT_STEPS: Record<string, string> = {
  gmail: 'Brave profile 6 (BonneyMantra, Google account 1inchunitedefi@gmail.com). Connect Gmail from Pactovio Settings > Connectors (or POST /api/connectors/gmail/connect), approve the Google consent screen (read, send, drafts).',
  outlook: 'Sign in with the persona outlook.com account; connect Outlook (mail + calendar scopes). Outlook Calendar reuses this login.',
  outlook_calendar: 'Connect Outlook first; the calendar rides on the same Microsoft login.',
  slack: 'Connect Slack and pick the test workspace; the bot must be invited to the target channel (default #general).',
  microsoft_teams: 'Needs a Microsoft 365 work or school account (Teams has no personal-account API). Until one exists the catalogue shows needs_work_account.',
  hubspot: 'Connect a HubSpot developer test account (free). Needs a default sales pipeline.',
  salesforce: 'Connect a Salesforce Developer Edition org (free).',
  googledrive: 'Connect Google Drive with the same Google account (the app creates a "Pactovio" folder).',
  googlecalendar: 'Connect Google Calendar with the same Google account.',
  dropbox: 'Connect a Dropbox account (the app writes /Pactovio).',
  jira: 'Connect Jira Cloud (free site). The first visible project is used unless config.project_key is set.',
  asana: 'Connect Asana (free workspace).',
  docusign: 'NEEDS OUR OWN OAUTH APP: create a DocuSign developer-sandbox app (integration key + secret, redirect URI https://backend.composio.dev/api/v1/auth-apps/add), run scripts/connector-setup.ts docusign, then connect.',
  quickbooks: 'Connect a QuickBooks sandbox company.',
  xero: 'NEEDS OUR OWN OAUTH APP: register a Xero app, run scripts/connector-setup.ts xero (or reuse the existing probity-xero auth config with Gabriel\'s OK), then connect the Xero demo company.',
};

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const wanted = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const apiBase = flag('api')?.replace(/\/$/, '');
const userId = flag('user') ?? SAMPLE_USER_ID;
const key = process.env.COMPOSIO_API_KEY;
if (!key) { console.error('COMPOSIO_API_KEY is not set (see the header of this script).'); process.exit(2); }
if (!wanted.length) { console.error('Usage: connector-e2e.ts <provider ...|all> [--api URL] [--user composio-user-id]'); process.exit(2); }

const env = { COMPOSIO_API_KEY: key } as Env;
const composio = new Composio(env);
const results: { provider: string; status: 'PASS' | 'FAIL' | 'SKIP'; line: string }[] = [];
const report = (provider: string, status: 'PASS' | 'FAIL' | 'SKIP', line: string) => { results.push({ provider, status, line }); console.log(`${status.padEnd(4)} ${provider.padEnd(17)} ${line}`); };

function ctxFor(provider: string, accountId: string) {
  const row: ConnectorRow = { id: 'cnx_e2e', workspace_id: 'ws_e2e', provider, status: 'connected', external_account_id: accountId, meta: { composio_user_id: userId, config: {} }, connected_at: null };
  return makeCtx(env, row, {}, { saveConfig: async (p) => { row.meta.config = { ...row.meta.config, ...p }; } });
}

async function emailRoundTrip(provider: 'gmail' | 'outlook', accountId: string): Promise<void> {
  const name = `${provider}.email_intake`;
  if (!apiBase) return report(name, 'SKIP', 'pass --api https://<deployed pactovio> (and PACTOVIO_API_KEY=pk_...) to test the trigger -> intake round trip');
  const apiKey = process.env.PACTOVIO_API_KEY;
  if (!apiKey) return report(name, 'SKIP', 'PACTOVIO_API_KEY is not set (create one at POST /api/api-keys)');
  const ctx = ctxFor(provider, accountId);
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/samples/emails/mail_k_port_fog.json'), 'utf8')) as { subject: string; body_text: string };
  const tag = `[e2e ${Date.now().toString(36)}]`;
  const t0 = Date.now();
  try {
    await PROVIDER_ACTIONS[provider]!.watch_inbox!.run({}, ctx);
    const sent = await PROVIDER_ACTIONS[provider]!.send_test_message!.run({ subject: `${tag} ${fixture.subject}`, body: fixture.body_text }, ctx);
    let found: { id: string; door: string; status: string; title: string } | undefined;
    while (!found && Date.now() - t0 < 6 * 60_000) {
      await new Promise((r) => setTimeout(r, 15_000));
      const res = await fetch(`${apiBase}/v1/intakes?limit=30`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`GET /v1/intakes -> ${res.status}`);
      found = ((await res.json()) as { items: { id: string; door: string; status: string; title: string }[] }).items.find((i) => i.title.includes(tag));
    }
    if (!found) return report(name, 'FAIL', `no intake after 6 minutes (Composio webhook subscription -> ${apiBase}/webhooks/composio, COMPOSIO_WEBHOOK_SECRET)`);
    // classification runs inside IntakeWorkflow: give it a moment
    for (let i = 0; i < 12 && found.status === 'new'; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      found = ((await (await fetch(`${apiBase}/v1/intakes?limit=30`, { headers: { authorization: `Bearer ${apiKey}` } })).json()) as { items: typeof found[] }).items.find((i) => i!.id === found!.id) ?? found;
    }
    const ok = found.door === 'design' && found.status !== 'new' && found.status !== 'ignored';
    report(name, ok ? 'PASS' : 'FAIL', `intake=${found.id} door=${found.door} status=${found.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
    if (provider === 'gmail' && sent.id) await ctx.exec('GMAIL_MOVE_TO_TRASH', { message_id: sent.id }).catch(() => undefined); // clean up the fixture mail; the reply draft stays for review
  } catch (e) {
    report(name, 'FAIL', e instanceof Error ? e.message : String(e));
  }
}

const active = await composio.listConnectedAccounts({ userIds: [userId], statuses: ['ACTIVE'] });
const list = wanted.includes('all') ? PROVIDERS.map((p) => p.provider) : wanted;
for (const provider of list) {
  const spec = PROVIDERS.find((p) => p.provider === provider);
  if (!spec) { report(provider, 'FAIL', `unknown provider (${PROVIDERS.map((p) => p.provider).join(', ')})`); continue; }
  const acct = active.find((a) => a.toolkit === spec.toolkit);
  if (!acct) { report(provider, 'SKIP', `not connected -> ${CONNECT_STEPS[provider]}`); continue; }
  const action = PRIMARY[provider]!;
  const def = PROVIDER_ACTIONS[provider]![action]!;
  const ctx = ctxFor(provider, acct.id);
  const started = Date.now();
  const extra = provider === 'hubspot' || provider === 'salesforce'
    ? async (out: ActionOutput) => {
        const idKey = provider === 'hubspot' ? 'deal_id' : 'opportunity_id';
        const note = await PROVIDER_ACTIONS[provider]!.add_note!.run({ [idKey]: out.id, body: 'Pactovio connector test note: verdict BID.', title: 'Pactovio test' }, ctx);
        if (!note.id) throw new Error('note was not created');
      }
    : undefined;
  const r = await exerciseDef(def, ctx, undefined, extra);
  const ms = Date.now() - started;
  const bits = [`${provider}.${action}`, `id=${r.out?.id ?? '-'}`, r.out?.url ? `url=${r.out.url}` : '', `readback=${r.readback === null ? 'n/a' : r.readback ? 'ok' : 'MISSING'}`, `cleanup=${r.cleaned === null ? 'n/a' : r.cleaned ? 'ok' : 'FAILED (remove by hand)'}`, `${ms}ms`, r.error ? `error=${r.error}` : ''].filter(Boolean);
  report(provider, r.ok ? 'PASS' : 'FAIL', bits.join('  '));
  if (provider === 'gmail' || provider === 'outlook') await emailRoundTrip(provider, acct.id);
}

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const skip = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (not connected)`);
process.exit(fail ? 1 : 0);
