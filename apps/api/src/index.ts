import type { Env } from '@pactovio/contracts/env';
import type { PactovioEvent } from '@pactovio/contracts';
import { buildApp } from './app';
import { handleEvents } from './queue';
import { handleScheduled } from './scheduled';

export { PackRunWorkflow } from './workflows/pack-run';
export { ScanWorkflow } from './workflows/scan';
export { IntakeWorkflow } from './workflows/intake';
export { AgentHub } from './do/agent-hub';

const { app } = buildApp();

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<unknown>, env: Env) => handleEvents(batch as MessageBatch<PactovioEvent>, env),
  scheduled: (controller: ScheduledController, env: Env) => handleScheduled(controller, env),
} satisfies ExportedHandler<Env>;
