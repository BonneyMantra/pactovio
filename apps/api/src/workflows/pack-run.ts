import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '@pactovio/contracts/env';
import { failRun, runPackPipeline, runReplay, type PackRunParams, type Stepper } from '@pactovio/engine';

export type { PackRunParams };

/**
 * Durable pack run: load text, vision read, whole-pack extraction, gates, evidence matching, verdicts, drafts.
 * The pipeline lives in @pactovio/engine; each of its stages is one `step.do`, so a crash resumes at the last stage.
 * One retry per stage: a model call that failed twice should surface in the run, not loop.
 */
export class PackRunWorkflow extends WorkflowEntrypoint<Env, PackRunParams> {
  async run(event: WorkflowEvent<PackRunParams>, step: WorkflowStep): Promise<void> {
    const p = event.payload;
    const rc = { env: this.env, runId: p.runId, workspaceId: p.workspaceId, tenderId: p.tenderId };
    const stepper: Stepper = (name, fn) =>
      step.do(name, { retries: { limit: 1, delay: '8 seconds', backoff: 'constant' }, timeout: '25 minutes' }, fn as never) as never;
    try {
      if (p.replay) await runReplay(rc, stepper);
      else await runPackPipeline(rc, stepper);
    } catch (e) {
      await failRun(rc, e);
    }
  }
}
