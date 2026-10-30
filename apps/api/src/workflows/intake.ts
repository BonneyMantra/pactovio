import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import type { Env } from '@pactovio/contracts/env';
import { classifyStep, draftStep, fetchAndStore, markIntakeStatus, routeStep, type IntakeJob } from '@pactovio/connectors';

export type IntakeParams = IntakeJob;

/**
 * Durable intake: fetch the message and attachments, classify (Lightning), open the right object for the door
 * (design request via lane C, or tender documents + pack run for an RFP), save a reply DRAFT in the mailbox
 * (never sent) and ask for approval. One step per stage, so a crash resumes at the last stage.
 */
export class IntakeWorkflow extends WorkflowEntrypoint<Env, IntakeParams> {
  async run(event: WorkflowEvent<IntakeParams>, step: WorkflowStep): Promise<void> {
    const job = event.payload;
    const retry: WorkflowStepConfig = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '5 minutes' };
    // Step results are JSON round-tripped by the runtime (undefined fields drop), which the Serializable<T> type cannot express.
    const stage = <T>(name: string, fn: () => Promise<T>): Promise<T> => step.do(name, retry, fn as never) as Promise<T>;
    try {
      const msg = await stage('fetch message', () => fetchAndStore(this.env, job));
      const { cls, workspaceId } = await stage('classify', () => classifyStep(this.env, job, msg));
      await stage('route', () => routeStep(this.env, job, workspaceId, msg, cls));
      await stage('draft reply', () => draftStep(this.env, job, workspaceId, msg, cls));
    } catch (e) {
      console.error('IntakeWorkflow failed', job.intakeId, e instanceof Error ? e.message.slice(0, 200) : 'unknown');
      await markIntakeStatus(this.env, job.intakeId, 'new').catch(() => undefined);
      throw e;
    }
  }
}
