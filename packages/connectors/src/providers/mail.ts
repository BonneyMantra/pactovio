import { ActionError, need, type ActionCtx, type ProviderActions } from '../actions';
import { deepFind } from '../util';

const SAMPLE_DRAFT = { to: 'buyer@example.org', subject: 'Pactovio connector test draft', body: 'This draft was created by the Pactovio connector test. It was never sent.' };

async function watch(ctx: ActionCtx, slug: string, config: Record<string, unknown>) {
  const id = await ctx.composio.upsertTrigger(slug, { userId: ctx.account.userId, connectedAccountId: ctx.account.id, config });
  await ctx.saveConfig({ trigger: { id, slug } });
  return { id, url: null, details: { trigger_id: id, trigger_slug: slug } };
}

async function unwatch(ctx: ActionCtx) {
  const t = ctx.meta.config?.trigger as { id?: string } | undefined;
  if (!t?.id) throw new ActionError('No trigger registered for this workspace', 'not_configured');
  await ctx.composio.deleteTrigger(t.id);
  await ctx.saveConfig({ trigger: null });
  return { id: t.id };
}

/** Own address guard: Pactovio never sends mail to anyone but the connected mailbox itself (connector tests only). */
async function ownAddress(ctx: ActionCtx, tool: string, keys: string[]): Promise<string> {
  const email = deepFind(await ctx.exec(tool, {}), keys);
  if (!email) throw new ActionError('Could not read the connected mailbox address', 'tool_failed');
  return email.toLowerCase();
}

export const gmail: ProviderActions = {
  watch_inbox: { summary: 'Register the new-message trigger (polls every minute)', run: (_i, ctx) => watch(ctx, 'GMAIL_NEW_GMAIL_MESSAGE', { labelIds: 'INBOX', interval: 1 }) },
  unwatch_inbox: { summary: 'Delete the new-message trigger', run: (_i, ctx) => unwatch(ctx) },
  get_message: {
    summary: 'Fetch one message by id',
    run: async (i, ctx) => {
      const data = await ctx.exec('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: need(i.message_id, 'message_id'), format: 'full' });
      return { id: deepFind(data, ['messageId', 'id']) ?? i.message_id, details: { subject: deepFind(data, ['subject']) } };
    },
  },
  create_draft: {
    summary: 'Save a draft (never sent)',
    run: async (i, ctx) => {
      const args: Record<string, unknown> = { recipient_email: need(i.to, 'to'), body: need(i.body, 'body'), is_html: false };
      if (i.thread_id) args.thread_id = i.thread_id; // threaded replies must leave the subject empty
      else args.subject = need(i.subject, 'subject');
      const data = await ctx.exec('GMAIL_CREATE_EMAIL_DRAFT', args);
      const id = deepFind(data, ['draft_id', 'draftId', 'id']);
      return { id, url: id ? 'https://mail.google.com/mail/u/0/#drafts' : null, details: { draft_id: id } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('GMAIL_GET_DRAFT', { draft_id: out.id }), ['id', 'draft_id']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('GMAIL_DELETE_DRAFT', { draft_id: out.id }); },
    sample: () => SAMPLE_DRAFT,
  },
  send_test_message: {
    summary: 'Send a message from the connected mailbox to itself (fixtures and e2e only)',
    run: async (i, ctx) => {
      const own = await ownAddress(ctx, 'GMAIL_GET_PROFILE', ['emailAddress', 'email']);
      if (i.to && String(i.to).toLowerCase() !== own) throw new ActionError('send_test_message only sends to the connected mailbox itself', 'bad_input');
      const data = await ctx.exec('GMAIL_SEND_EMAIL', { recipient_email: own, subject: need(i.subject, 'subject'), body: need(i.body, 'body'), is_html: false });
      const id = deepFind(data, ['messageId', 'message_id', 'id']);
      return { id, details: { thread_id: deepFind(data, ['threadId', 'thread_id']), to: own } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: out.id }), ['id', 'messageId']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('GMAIL_MOVE_TO_TRASH', { message_id: out.id }); },
    sample: () => ({ subject: 'Pactovio connector test message', body: 'Sent by the Pactovio connector test to the connected mailbox itself.' }),
  },
};

export const outlook: ProviderActions = {
  watch_inbox: { summary: 'Register the new-message trigger', run: (_i, ctx) => watch(ctx, 'OUTLOOK_MESSAGE_TRIGGER', { folder_id: 'inbox' }) },
  unwatch_inbox: { summary: 'Delete the new-message trigger', run: (_i, ctx) => unwatch(ctx) },
  get_message: {
    summary: 'Fetch one message by id',
    run: async (i, ctx) => {
      const data = await ctx.exec('OUTLOOK_GET_MESSAGE', { message_id: need(i.message_id, 'message_id') });
      return { id: deepFind(data, ['id']) ?? i.message_id, details: { subject: deepFind(data, ['subject']) } };
    },
  },
  create_draft: {
    summary: 'Save a draft (never sent); a reply draft when message_id is given',
    run: async (i, ctx) => {
      if (i.message_id) {
        const data = await ctx.exec('OUTLOOK_CREATE_DRAFT_REPLY', { message_id: i.message_id, comment: need(i.body, 'body') });
        const id = deepFind(data, ['id']);
        return { id, url: deepFind(data, ['webLink']) ?? 'https://outlook.live.com/mail/0/drafts', details: { draft_id: id } };
      }
      const data = await ctx.exec('OUTLOOK_CREATE_DRAFT', { subject: need(i.subject, 'subject'), body: need(i.body, 'body'), to_recipients: [need(i.to, 'to')], is_html: false });
      const id = deepFind(data, ['id']);
      return { id, url: deepFind(data, ['webLink']) ?? 'https://outlook.live.com/mail/0/drafts', details: { draft_id: id } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('OUTLOOK_GET_MESSAGE', { message_id: out.id }), ['id']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('OUTLOOK_DELETE_MESSAGE', { message_id: out.id }); },
    sample: () => SAMPLE_DRAFT,
  },
  send_test_message: {
    summary: 'Send a message from the connected mailbox to itself (fixtures and e2e only)',
    run: async (i, ctx) => {
      const own = await ownAddress(ctx, 'OUTLOOK_GET_PROFILE', ['mail', 'userPrincipalName', 'email']);
      if (i.to && String(i.to).toLowerCase() !== own) throw new ActionError('send_test_message only sends to the connected mailbox itself', 'bad_input');
      await ctx.exec('OUTLOOK_SEND_EMAIL', { to: own, subject: need(i.subject, 'subject'), body: need(i.body, 'body'), is_html: false });
      return { id: null, details: { to: own } }; // sendMail returns no id; the trigger delivers the received copy
    },
    sample: () => ({ subject: 'Pactovio connector test message', body: 'Sent by the Pactovio connector test to the connected mailbox itself.' }),
  },
};
