import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NotImplemented } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export interface PackRunParams {
  runId: string;
  workspaceId: string;
  tenderId: string;
  replay?: boolean;
}

/** Lane: engine. extractPack -> read whole pack -> requirements -> evidence match -> verdicts; one run_step per model call. */
export class PackRunWorkflow extends WorkflowEntrypoint<Env, PackRunParams> {
  async run(_event: WorkflowEvent<PackRunParams>, _step: WorkflowStep): Promise<void> {
    throw new NotImplemented('PackRunWorkflow');
  }
}
