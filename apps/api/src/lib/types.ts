import type { Env } from '@pactovio/contracts/env';

export interface Auth {
  workspaceId: string;
  userId?: string;
  /** judge/app session id; null for API-key calls */
  sessionId: string | null;
  via: 'session' | 'apikey' | 'public';
}

export type AppEnv = { Bindings: Env; Variables: { auth: Auth } };

export const DEFAULT_WORKSPACE_ID = 'ws_harbour_digital';
export const SESSION_COOKIE = 'pv_s';
/** Judge-mode caps per session (BUILD-BRIEF section 4). */
export const CAPS = { runs: 2, tavily: 3, agentTurnsPerMin: 10 } as const;
