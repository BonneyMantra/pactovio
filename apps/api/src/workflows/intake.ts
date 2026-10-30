import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NotImplemented } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export interface IntakeParams {
  intakeId: string;
  workspaceId: string;
}

/** Lane: connectors. classify -> route to door (tender | rfp | design) -> start the matching run. */
export class IntakeWorkflow extends WorkflowEntrypoint<Env, IntakeParams> {
  async run(_event: WorkflowEvent<IntakeParams>, _step: WorkflowStep): Promise<void> {
    throw new NotImplemented('IntakeWorkflow');
  }
}
