import type { Env } from '@pactovio/contracts/env';
import { hubFetch } from './client';

/**
 * Wake every workspace's AgentHub so its daily alarm (06:30 MYT digest, deadline and certificate nudges) is armed.
 * A Durable Object only arms its alarm when something reaches it; call this from the nightly cron so the agent
 * keeps running for workspaces nobody has opened. Never throws.
 */
export async function ensureAgentAlarms(env: Env): Promise<number> {
  try {
    const ws = await env.DB.prepare('SELECT id FROM workspaces').all<{ id: string }>();
    const res = await Promise.allSettled(ws.results.map((w) => hubFetch(env, { workspaceId: w.id, sessionId: null }, '/ensure', { method: 'POST', body: {} })));
    return res.filter((r) => r.status === 'fulfilled').length;
  } catch (e) {
    console.error('ensureAgentAlarms failed', e instanceof Error ? e.name : 'unknown');
    return 0;
  }
}
