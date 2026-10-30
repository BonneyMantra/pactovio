import { endpoints, type ConnectorCatalogItem } from '@pactovio/contracts';
import { rows } from '../lib/db';
import type { Register } from '../lib/router';

type Seed = Omit<ConnectorCatalogItem, 'status' | 'connected_at' | 'external_account_id'>;

/** Static catalogue; live status is merged in from the `connectors` table. Lane connectors extends actions. */
export const CATALOG: Seed[] = [
  { provider: 'gmail', name: 'Gmail', category: 'email', description: 'Watch a shared inbox for inbound RFPs and RFQs.', actions: ['read_inbox', 'send_reply'] },
  { provider: 'outlook', name: 'Outlook', category: 'email', description: 'Watch a Microsoft 365 mailbox for inbound RFPs and RFQs.', actions: ['read_inbox', 'send_reply'] },
  { provider: 'slack', name: 'Slack', category: 'chat', description: 'Post bid/no-bid verdicts and approval requests to a channel.', actions: ['post_message'] },
  { provider: 'googlecalendar', name: 'Google Calendar', category: 'calendar', description: 'Put tender deadlines on the bid team calendar.', actions: ['create_event'] },
  { provider: 'googledrive', name: 'Google Drive', category: 'storage', description: 'Save filled forms and proposals to a folder.', actions: ['upload_file'] },
  { provider: 'hubspot', name: 'HubSpot', category: 'crm', description: 'Create deals for qualified RFPs and quotes.', actions: ['create_deal'] },
  { provider: 'notion', name: 'Notion', category: 'tasks', description: 'Create a bid-room page with the requirement matrix.', actions: ['create_page'] },
];

export const register: Register = (r) => {
  r.on(endpoints.listConnectors, async ({ db, workspaceId }) => {
    const live = await rows<{ provider: string; status: ConnectorCatalogItem['status']; external_account_id: string | null; connected_at: string | null }>(
      db, 'SELECT provider, status, external_account_id, connected_at FROM connectors WHERE workspace_id = ?', workspaceId,
    );
    return {
      items: CATALOG.map((c) => {
        const l = live.find((x) => x.provider === c.provider);
        return { ...c, status: l?.status ?? 'available', connected_at: l?.connected_at ?? null, external_account_id: l?.external_account_id ?? null };
      }),
    };
  });
  r.stub(endpoints.connectConnector, 'connectors.connectUrl');
  r.stub(endpoints.disconnectConnector, 'connectors disconnect');
  r.stub(endpoints.testConnector, 'connectors.runAction');
};
