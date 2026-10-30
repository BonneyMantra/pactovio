import { newId, type EventType, type PactovioEvent } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

/**
 * Emit a domain event: (1) insert into `events`, (2) enqueue on EVENTS for webhook/connector fan-out,
 * (3) notify the workspace's AgentHub Durable Object so connected chats see it live.
 * Never throws: an emit failure must not fail the caller's work.
 */
export async function emit(
  env: Env,
  workspaceId: string,
  type: EventType,
  payload: Record<string, unknown> = {},
): Promise<PactovioEvent> {
  const event: PactovioEvent = { id: newId('event'), workspace_id: workspaceId, type, payload, at: new Date().toISOString() };
  try {
    await env.DB.prepare('INSERT INTO events (id, workspace_id, type, payload_json, at) VALUES (?, ?, ?, ?, ?)')
      .bind(event.id, workspaceId, type, JSON.stringify(payload), event.at)
      .run();
  } catch (err) {
    console.error('emit: events insert failed', err instanceof Error ? err.message : err);
  }
  await Promise.allSettled([
    env.EVENTS.send(event),
    (async () => {
      const stub = env.AGENT.get(env.AGENT.idFromName(workspaceId));
      await stub.fetch('https://agent.internal/notify', { method: 'POST', body: JSON.stringify(event) });
    })(),
  ]);
  return event;
}
export * from './signing';
