import { NotImplemented, type Door } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  attachments: { filename: string; r2Key: string }[];
  receivedAt: string;
}
export interface Classification {
  door: Door | 'ignore';
  confidence: number;
  reason: string;
}

/** Lane: connectors. Classify an inbound email into a door (MODEL_FAST, thinking off). */
export async function classifyEmail(_env: Env, _msg: InboundMessage): Promise<Classification> {
  throw new NotImplemented('connectors.classifyEmail');
}

/** Lane: connectors. Composio hosted-auth redirect URL for a provider (gmail, outlook, slack, ...). */
export async function connectUrl(_env: Env, _workspaceId: string, _provider: string): Promise<string> {
  throw new NotImplemented('connectors.connectUrl');
}

/** Lane: connectors. Run an action on a connected provider (slack.post_message, calendar.create_event, ...). */
export async function runAction(
  _env: Env, _workspaceId: string, _provider: string, _action: string, _input: Record<string, unknown>,
): Promise<{ ok: boolean; output?: unknown }> {
  throw new NotImplemented('connectors.runAction');
}
