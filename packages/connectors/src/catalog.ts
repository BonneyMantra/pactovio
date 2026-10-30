import type { ConnectorCatalogItem, ConnectorRule } from '@pactovio/contracts';

type Category = ConnectorCatalogItem['category'];

export interface ProviderSpec {
  /** Pactovio provider id (path param, connectors.provider). */
  provider: string;
  /** Composio toolkit slug. */
  toolkit: string;
  name: string;
  category: Category;
  description: string;
  whatItDoes: string;
  /** Low-level actions callable through POST /connectors/{id}/test and runAction. */
  actions: string[];
  /** Composio managed OAuth available (verified against GET /toolkits/{slug} on 30 Oct 2026). */
  managedAuth: boolean;
  /** Provider shares one Composio connected account with another provider id (Outlook mail + calendar). */
  sharesAccountWith?: string;
  /** Needs a Microsoft 365 work/school account; personal outlook.com cannot connect. */
  needsWorkAccount?: boolean;
  /** Own OAuth app required: what to register and which fields Composio takes. */
  ownApp?: string;
}

export const PROVIDERS: ProviderSpec[] = [
  { provider: 'gmail', toolkit: 'gmail', name: 'Gmail', category: 'email', managedAuth: true,
    description: 'Watch a shared inbox for inbound RFPs, RFQs and design requests.',
    whatItDoes: 'A new email fires a Composio trigger; Pactovio fetches it and its attachments, classifies it, opens an intake and saves a reply as a Gmail draft (never sent).',
    actions: ['watch_inbox', 'unwatch_inbox', 'get_message', 'create_draft', 'send_test_message'] },
  { provider: 'outlook', toolkit: 'outlook', name: 'Outlook', category: 'email', managedAuth: true,
    description: 'Watch a Microsoft mailbox for inbound RFPs, RFQs and design requests.',
    whatItDoes: 'A new message fires a Composio trigger; Pactovio fetches it and its attachments, classifies it, opens an intake and saves a reply as an Outlook draft (never sent).',
    actions: ['watch_inbox', 'unwatch_inbox', 'get_message', 'create_draft', 'send_test_message'] },
  { provider: 'slack', toolkit: 'slack', name: 'Slack', category: 'chat', managedAuth: true,
    description: 'Proactive agent messages with approve and decline links.',
    whatItDoes: 'The agent posts classified intakes, bid/no-bid verdicts and approval requests to a channel with signed approve and decline links that round-trip back into Pactovio.',
    actions: ['post_message'] },
  { provider: 'microsoft_teams', toolkit: 'microsoft_teams', name: 'Microsoft Teams', category: 'chat', managedAuth: true, needsWorkAccount: true,
    description: 'Proactive agent messages with approve and decline links.',
    whatItDoes: 'The agent posts the same proactive messages, with approve and decline links, to a Teams channel. Needs a Microsoft 365 work or school account.',
    actions: ['post_message'] },
  { provider: 'hubspot', toolkit: 'hubspot', name: 'HubSpot', category: 'crm', managedAuth: true,
    description: 'A deal per bid with stage, value and deadline.',
    whatItDoes: 'Creates or updates one deal per tender or quote (stage, amount, close date) and attaches a note with the verdict and its reasons.',
    actions: ['create_deal', 'update_deal', 'add_note'] },
  { provider: 'salesforce', toolkit: 'salesforce', name: 'Salesforce', category: 'crm', managedAuth: true,
    description: 'An opportunity per bid with stage, value and deadline.',
    whatItDoes: 'Creates or updates one opportunity per tender or quote (stage, amount, close date) and attaches a note with the verdict and its reasons.',
    actions: ['create_opportunity', 'update_opportunity', 'add_note'] },
  { provider: 'googledrive', toolkit: 'googledrive', name: 'Google Drive', category: 'storage', managedAuth: true,
    description: 'Filled buyer forms, proposals and quotes in a Pactovio folder.',
    whatItDoes: 'Uploads the buyer forms Pactovio filled, the proposal and the quote into a "Pactovio" folder.',
    actions: ['upload_file'] },
  { provider: 'dropbox', toolkit: 'dropbox', name: 'Dropbox', category: 'storage', managedAuth: true,
    description: 'Filled buyer forms, proposals and quotes in a Pactovio folder.',
    whatItDoes: 'Uploads the buyer forms Pactovio filled, the proposal and the quote into /Pactovio.',
    actions: ['upload_file'] },
  { provider: 'googlecalendar', toolkit: 'googlecalendar', name: 'Google Calendar', category: 'calendar', managedAuth: true,
    description: 'Tender deadlines and clarification dates on the bid calendar.',
    whatItDoes: 'Adds the submission deadline and the clarification-question date of every bid as calendar events.',
    actions: ['create_event'] },
  { provider: 'outlook_calendar', toolkit: 'outlook', name: 'Outlook Calendar', category: 'calendar', managedAuth: true, sharesAccountWith: 'outlook',
    description: 'Tender deadlines and clarification dates on the bid calendar.',
    whatItDoes: 'Adds the submission deadline and the clarification-question date of every bid to the Outlook calendar (same Microsoft login as Outlook mail).',
    actions: ['create_event'] },
  { provider: 'jira', toolkit: 'jira', name: 'Jira', category: 'tasks', managedAuth: true,
    description: 'One task per gap or missing-evidence row of the requirement matrix.',
    whatItDoes: 'Opens one Jira issue per GAP or NEEDS_EVIDENCE requirement, assigned and dated to the bid deadline.',
    actions: ['create_task'] },
  { provider: 'asana', toolkit: 'asana', name: 'Asana', category: 'tasks', managedAuth: true,
    description: 'One task per gap or missing-evidence row of the requirement matrix.',
    whatItDoes: 'Creates one Asana task per GAP or NEEDS_EVIDENCE requirement, assigned and dated to the bid deadline.',
    actions: ['create_task'] },
  { provider: 'docusign', toolkit: 'docusign', name: 'DocuSign', category: 'signing', managedAuth: false,
    ownApp: 'Register a DocuSign developer-sandbox app (integration key + secret, redirect URI https://backend.composio.dev/api/v1/auth-apps/add). Composio fields: client_id, client_secret, full = https://account-d.docusign.com, scopes = signature,impersonation.',
    description: 'Send the approved quote for signature (sandbox).',
    whatItDoes: 'Sends the quote as a DocuSign envelope for signature; in the demo the only recipient is the connected account owner.',
    actions: ['send_for_signature'] },
  { provider: 'quickbooks', toolkit: 'quickbooks', name: 'QuickBooks', category: 'accounting', managedAuth: true,
    description: 'Customer and estimate from an approved quote.',
    whatItDoes: 'Creates the customer (if new) and an estimate in QuickBooks from an approved Pactovio quote.',
    actions: ['create_estimate'] },
  { provider: 'xero', toolkit: 'xero', name: 'Xero', category: 'accounting', managedAuth: false,
    ownApp: 'Register a Xero OAuth 2.0 app (client id + secret, redirect URI https://backend.composio.dev/api/v1/auth-apps/add). Composio fields: client_id, client_secret. The Composio account already holds an auth config "probity-xero" belonging to another product; Pactovio does not reuse it unless told to.',
    description: 'Contact and quote from an approved Pactovio quote.',
    whatItDoes: 'Creates the contact (if new) and a quote in Xero from an approved Pactovio quote.',
    actions: ['create_estimate'] },
];

export const providerSpec = (id: string): ProviderSpec | undefined => PROVIDERS.find((p) => p.provider === id);

const on = (event: ConnectorRule['event'], action: string, filter?: Record<string, unknown>): ConnectorRule => ({ event, action, enabled: true, ...(filter ? { filter } : {}) });
const BID = { decision: ['BID', 'CONDITIONAL'] };

/** Sensible defaults; a workspace overrides single rules in connectors.meta_json.rules (keyed by event + action). */
export const DEFAULT_RULES: Record<string, ConnectorRule[]> = {
  gmail: [],
  outlook: [],
  // Chat is mirrored by the AgentHub (proactive messages with signed approve/decline links); rules here would double-post. Opt in per event if wanted.
  slack: [{ event: 'verdict.ready', action: 'post_message', enabled: false }],
  microsoft_teams: [{ event: 'verdict.ready', action: 'post_message', enabled: false }],
  hubspot: [on('verdict.ready', 'sync_bid', BID)],
  salesforce: [on('verdict.ready', 'sync_bid', BID)],
  googledrive: [on('quote.ready', 'upload_artifacts'), on('answer.drafted', 'upload_artifacts')],
  dropbox: [on('quote.ready', 'upload_artifacts'), on('answer.drafted', 'upload_artifacts')],
  googlecalendar: [on('verdict.ready', 'add_deadline', BID)],
  outlook_calendar: [on('verdict.ready', 'add_deadline', BID)],
  jira: [on('run.completed', 'create_gap_tasks')],
  asana: [on('run.completed', 'create_gap_tasks')],
  docusign: [{ event: 'quote.ready', action: 'send_quote_for_signature', enabled: false }],
  quickbooks: [on('quote.ready', 'create_estimate')],
  xero: [on('quote.ready', 'create_estimate')],
};

export const SAMPLE_USER_ID = 'pactovio-demo';
