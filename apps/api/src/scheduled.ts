import { newId } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

/** Cron `0 22 * * *` UTC (06:00 MYT): start the nightly ScanWorkflow. */
export async function handleScheduled(_controller: ScheduledController, env: Env): Promise<void> {
  await env.SCAN.create({ id: newId('run'), params: { trigger: 'cron' } });
}
