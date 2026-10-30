import type { Env } from '@pactovio/contracts/env';
import type { PactovioEvent } from '@pactovio/contracts';

/**
 * Queue consumer for `pactovio-events`. Lane: connectors/events fills in the fan-out:
 * webhook_endpoints (signed with @pactovio/events signWebhook + deriveWebhookSecret) and connector actions.
 * Foundation: acknowledge.
 */
export async function handleEvents(batch: MessageBatch<PactovioEvent>, _env: Env): Promise<void> {
  for (const msg of batch.messages) msg.ack();
}
