import type { ProviderActions } from '../actions';
import { gmail, outlook } from './mail';
import { slack, microsoft_teams } from './chat';
import { hubspot, salesforce } from './crm';
import { googledrive, dropbox } from './files';
import { googlecalendar, outlook_calendar } from './calendar';
import { jira, asana } from './tasks';
import { docusign, quickbooks, xero } from './finance';

/** provider id -> low-level actions (what POST /connectors/{id}/test and the event rules run). */
export const PROVIDER_ACTIONS: Record<string, ProviderActions> = {
  gmail, outlook, slack, microsoft_teams, hubspot, salesforce, googledrive, dropbox,
  googlecalendar, outlook_calendar, jira, asana, docusign, quickbooks, xero,
};
