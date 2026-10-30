import { HttpError, type AgentWsMessage, type AgentMessage } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import type { streamToolLoop } from '@pactovio/agent';
import type { HubStore } from './store';

/** Everything the hub logic needs from its Durable Object shell; tests pass fakes. */
export interface HubDeps {
  env: Env;
  store: HubStore;
  workspaceId: string;
  now(): number;
  /** Deliver a frame to connected sockets. `session` limits delivery to that session's sockets; omit for the whole workspace. */
  send(frame: AgentWsMessage, scope?: { session?: string }): void;
  /** A proactive message was stored in the inbox: fan out to SSE subscribers. */
  publish(message: AgentMessage & { event_type: string | null }): void;
  loop: typeof streamToolLoop;
}

export const sessionKeyOf = (sessionId: string | null | undefined): string => sessionId ?? 'apikey';

export const refuse = (status: 400 | 403 | 404 | 409 | 429 | 502, error: string, code: string): never => {
  throw new HttpError(status, error, code);
};

export const BASE_URL = (env: Env): string => ((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN ?? 'https://pactovio.pages.dev').replace(/\/$/, '');
