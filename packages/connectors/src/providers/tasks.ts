import { ActionError, need, type ActionCtx, type ProviderActions } from '../actions';
import { deepFind, deepFindArray } from '../util';

async function jiraProject(ctx: ActionCtx): Promise<string> {
  const saved = ctx.meta.config?.project_key as string | undefined;
  if (saved) return saved;
  const key = deepFind((deepFindArray(await ctx.exec('JIRA_GET_ALL_PROJECTS', { maxResults: 20 }), ['values', 'projects']) ?? [])[0], ['key']);
  if (!key) throw new ActionError('No Jira project visible to the connected account; set config.project_key', 'not_configured');
  await ctx.saveConfig({ project_key: key });
  return key;
}

async function jiraAssignee(ctx: ActionCtx): Promise<string | null> {
  const saved = ctx.meta.config?.assignee_account_id as string | undefined;
  if (saved) return saved;
  const me = deepFind(await ctx.exec('JIRA_GET_CURRENT_USER', {}), ['accountId']);
  if (me) await ctx.saveConfig({ assignee_account_id: me });
  return me;
}

const SAMPLE = () => ({ title: 'Pactovio connector test task', description: 'Created by the Pactovio connector test.', due_date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) });

export const jira: ProviderActions = {
  create_task: {
    summary: 'Create an issue (assigned, dated)',
    run: async (i, ctx) => {
      const project_key = await jiraProject(ctx);
      const assignee = await jiraAssignee(ctx);
      const data = await ctx.exec('JIRA_CREATE_ISSUE', {
        project_key, issue_type: (ctx.meta.config?.issue_type as string | undefined) ?? 'Task', summary: String(need(i.title, 'title')).slice(0, 250),
        ...(i.description ? { description: String(i.description).slice(0, 30_000) } : {}),
        ...(i.due_date ? { due_date: String(i.due_date).slice(0, 10) } : {}),
        ...(Array.isArray(i.labels) && i.labels.length ? { labels: i.labels.map((l: string) => l.replace(/\s+/g, '-')) } : { labels: ['pactovio'] }),
        ...(assignee ? { assignee } : {}),
      });
      return { id: deepFind(data, ['key']), url: null, details: { project_key, issue_id: deepFind(data, ['id']) } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('JIRA_GET_ISSUE', { issue_id_or_key: out.id }), ['key']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('JIRA_DELETE_ISSUE', { issue_id_or_key: out.id }); },
    sample: SAMPLE,
  },
};

async function asanaWorkspace(ctx: ActionCtx): Promise<string> {
  const saved = ctx.meta.config?.workspace_gid as string | undefined;
  if (saved) return saved;
  const gid = deepFind((deepFindArray(await ctx.exec('ASANA_GET_MULTIPLE_WORKSPACES', { limit: 10 }), ['data', 'workspaces']) ?? [])[0], ['gid']);
  if (!gid) throw new ActionError('No Asana workspace visible to the connected account', 'not_configured');
  await ctx.saveConfig({ workspace_gid: gid });
  return gid;
}

export const asana: ProviderActions = {
  create_task: {
    summary: 'Create a task (assigned to the connected user, dated)',
    run: async (i, ctx) => {
      const workspace = await asanaWorkspace(ctx);
      const project = ctx.meta.config?.project_gid as string | undefined;
      const data = await ctx.exec('ASANA_CREATE_A_TASK', {
        data: {
          name: String(need(i.title, 'title')).slice(0, 250), workspace, assignee: 'me',
          ...(i.description ? { notes: String(i.description).slice(0, 60_000) } : {}),
          ...(i.due_date ? { due_on: String(i.due_date).slice(0, 10) } : {}),
          ...(project ? { projects: [project] } : {}),
        },
      });
      return { id: deepFind(data, ['gid']), url: deepFind(data, ['permalink_url']) };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('ASANA_GET_A_TASK', { task_gid: out.id }), ['gid']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('ASANA_DELETE_TASK', { task_gid: out.id }); },
    sample: SAMPLE,
  },
};
