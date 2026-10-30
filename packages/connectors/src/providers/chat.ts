import { ActionError, need, type ActionCtx, type ProviderActions } from '../actions';
import { deepFind, deepFindArray } from '../util';

interface LinkButton { label: string; url: string }

/** Slack Block Kit: a text section plus link buttons. Link buttons open a URL, so approve/decline round-trips need no Slack interactivity app. */
export function slackBlocks(text: string, buttons: LinkButton[]) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    ...(buttons.length
      ? [{ type: 'actions', elements: buttons.map((b, i) => ({ type: 'button', text: { type: 'plain_text', text: b.label }, url: b.url, ...(i === 0 ? { style: 'primary' } : { style: 'danger' }) })) }]
      : []),
  ];
}

async function slackChannel(ctx: ActionCtx, wanted?: string): Promise<string> {
  const saved = wanted ?? (ctx.meta.config?.channel as string | undefined);
  if (saved && /^[CGD][A-Z0-9]{6,}$/.test(saved)) return saved;
  const name = (saved ?? 'general').replace(/^#/, '');
  const data = await ctx.exec('SLACK_FIND_CHANNELS', { query: name, exact_match: true, limit: 5 });
  let id = deepFind(data, ['id']);
  if (!id) {
    const any = deepFindArray(await ctx.exec('SLACK_LIST_ALL_CHANNELS', { limit: 20 }), ['channels']);
    id = (any?.[0] as { id?: string } | undefined)?.id ?? null;
  }
  if (!id) throw new ActionError(`Slack channel #${name} not found; set config.channel`, 'not_configured');
  await ctx.saveConfig({ channel: id });
  return id;
}

const SAMPLE = { text: '*Pactovio connector test.* This message was posted by the Pactovio connector test and can be deleted.' };

export const slack: ProviderActions = {
  post_message: {
    summary: 'Post a message (optionally with approve/decline link buttons)',
    run: async (i, ctx) => {
      const channel = await slackChannel(ctx, i.channel);
      const buttons: LinkButton[] = i.buttons ?? [];
      const text = need(i.text, 'text');
      // Always Block Kit: the text is Slack mrkdwn (*bold*, <url|label>), which blocks render and markdown_text does not.
      const args = { channel, blocks: slackBlocks(text.slice(0, 2900), buttons), fallback_text: text.slice(0, 300) };
      const data = await ctx.exec('SLACK_SEND_MESSAGE', args);
      const ts = deepFind(data, ['ts', 'message_ts']);
      return { id: ts, url: deepFind(data, ['permalink']), details: { channel, ts } };
    },
    readback: async (out, ctx) => {
      const channel = out.details?.channel as string; const ts = out.id;
      if (!channel || !ts) return false;
      const data = await ctx.exec('SLACK_FETCH_CONVERSATION_HISTORY', { channel, oldest: ts, latest: ts, inclusive: true, limit: 1 });
      return (deepFindArray(data, ['messages']) ?? []).length > 0;
    },
    cleanup: async (out, ctx) => {
      if (out.details?.channel && out.id) await ctx.exec('SLACK_DELETES_A_MESSAGE_FROM_A_CHAT', { channel: out.details.channel, ts: out.id });
    },
    sample: () => SAMPLE,
  },
};

function teamsContent(text: string, buttons: LinkButton[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>') // the hub posts markdown links to Teams
    .replace(/\*(.+?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const links = buttons.map((b) => `<a href="${esc(b.url)}">${esc(b.label)}</a>`).join(' &nbsp;|&nbsp; ');
  return links ? `${body}<br><br>${links}` : body;
}

async function teamsTarget(ctx: ActionCtx): Promise<{ team: string; channel: string }> {
  const cfg = ctx.meta.config as { team_id?: string; channel_id?: string } | undefined;
  if (cfg?.team_id && cfg.channel_id) return { team: cfg.team_id, channel: cfg.channel_id };
  const team = deepFind(deepFindArray(await ctx.exec('MICROSOFT_TEAMS_TEAMS_LIST', {}), ['value', 'teams'])?.[0], ['id']);
  if (!team) throw new ActionError('The connected Microsoft account is not a member of any Team (a Microsoft 365 work or school account is required)', 'not_configured');
  const channels = deepFindArray(await ctx.exec('MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS', { team_id: team }), ['value', 'channels']) ?? [];
  const general = channels.find((c) => /general/i.test(String((c as { displayName?: string }).displayName))) ?? channels[0];
  const channel = deepFind(general, ['id']);
  if (!channel) throw new ActionError('No channel found in the first Team', 'not_configured');
  await ctx.saveConfig({ team_id: team, channel_id: channel });
  return { team, channel };
}

export const microsoft_teams: ProviderActions = {
  post_message: {
    summary: 'Post a message to a Team channel (with approve/decline links)',
    run: async (i, ctx) => {
      const { team, channel } = await teamsTarget(ctx);
      const data = await ctx.exec('MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE', {
        team_id: team, channel_id: channel, content: teamsContent(need(i.text, 'text'), i.buttons ?? []), content_type: 'html',
      });
      const id = deepFind(data, ['id']);
      return { id, url: deepFind(data, ['webUrl']), details: { team_id: team, channel_id: channel } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('MICROSOFT_TEAMS_GET_CHANNEL_MESSAGE', { team_id: out.details?.team_id, channel_id: out.details?.channel_id, message_id: out.id }), ['id']) !== null,
    cleanup: async (out, ctx) => {
      if (out.id) await ctx.exec('MICROSOFT_TEAMS_DELETE_SOFT_MESSAGE', { team_id: out.details?.team_id, channel_id: out.details?.channel_id, message_id: out.id });
    },
    sample: () => SAMPLE,
  },
};
