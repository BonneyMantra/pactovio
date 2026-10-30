import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runNightlyScan } from '@pactovio/sources';
import type { Env } from '@pactovio/contracts/env';

export interface ScanParams {
  trigger: 'cron' | 'manual';
  workspaceId?: string;
}

/** Lane: sources. Nightly scan. Cron starts this; `runNightlyScan` does the work (stubbed until the sources lane lands). */
export class ScanWorkflow extends WorkflowEntrypoint<Env, ScanParams> {
  async run(_event: WorkflowEvent<ScanParams>, step: WorkflowStep): Promise<unknown> {
    return step.do('nightly-scan', async () => runNightlyScan(this.env));
  }
}
