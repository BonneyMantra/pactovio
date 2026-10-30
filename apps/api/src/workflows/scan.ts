import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import {
  emptyStats, ensurePack, fetchNotices, finishScan, loadWorkspaces, notifyMatches, triageWorkspace, upsertTenders,
  type ScanStats,
} from '@pactovio/sources';
import type { Env } from '@pactovio/contracts/env';

export interface ScanParams {
  trigger: 'cron' | 'manual';
  workspaceId?: string;
}

const NO_RETRY = { retries: { limit: 0, delay: '1 second' as const } };
const RETRY_FETCH = { retries: { limit: 2, delay: '10 seconds' as const, backoff: 'exponential' as const }, timeout: '3 minutes' as const };

/**
 * Nightly scan (cron `0 22 * * *` = 06:00 MYT). Durable steps: fetch TED + UK notices, upsert, Lightning triage per
 * workspace (flex tier, concurrency 4), pack download + extraction per matched eTenders notice, tender.matched events,
 * per-day counters in limits_counters. Every stage is idempotent, so a replayed step never duplicates rows or events.
 */
export class ScanWorkflow extends WorkflowEntrypoint<Env, ScanParams> {
  async run(event: WorkflowEvent<ScanParams>, step: WorkflowStep): Promise<ScanStats> {
    const env = this.env;
    const stats = emptyStats();
    // Step results are plain JSON; the SDK's Serializable<T> type cannot see through our `unknown` fields.
    const run = <T>(name: string, cfg: WorkflowStepConfig, fn: () => Promise<T>): Promise<T> => step.do(name, cfg, fn as never) as Promise<T>;
    const workspaces = await run('load workspaces', NO_RETRY, () => loadWorkspaces(env, event.payload.workspaceId));
    const fetched = await run('fetch notices', RETRY_FETCH, () => fetchNotices(workspaces));
    stats.scanned = fetched.tenders.length;
    stats.errors.push(...fetched.errors);
    const stored = await run('upsert tenders', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const r = await upsertTenders(env, fetched.tenders);
      return r.filter((x) => x.isNew).length;
    });
    stats.new_tenders = stored;

    for (const ws of workspaces) {
      const r = await run(`triage ${ws.id}`, { ...NO_RETRY, timeout: '10 minutes' }, async () => {
        const { steps: _steps, ...rest } = await triageWorkspace(env, ws);
        return rest;
      });
      stats.triaged += r.triaged;
      stats.matched += r.matched;
      stats.matches.push(...r.matches);
      stats.errors.push(...r.errors);
    }

    for (const id of new Set(stats.matches.map((m) => m.tenderId))) {
      const p = await run(`pack ${id}`, { ...NO_RETRY, timeout: '5 minutes' }, async () => {
        try {
          return await ensurePack(env, id);
        } catch (e) {
          return { files: -1, error: e instanceof Error ? e.message.slice(0, 160) : 'failed' };
        }
      });
      if (p && p.files >= 0) { stats.packs++; stats.pack_files += p.files; }
      else if (p && 'error' in p) stats.errors.push(`pack ${id}: ${p.error}`);
    }

    await run('notify', NO_RETRY, () => notifyMatches(env, stats.matches));
    await run('finish', NO_RETRY, () => finishScan(env, stats));
    return stats;
  }
}
