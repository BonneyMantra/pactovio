import { ActionError, need, type ActionCtx, type ProviderActions } from '../actions';
import { deepFind, deepFindArray } from '../util';

/** Pactovio bid stages. */
export type BidStage = 'qualifying' | 'bidding' | 'submitted' | 'won' | 'lost';

const HUBSPOT_STAGE_WORDS: Record<BidStage, RegExp> = {
  qualifying: /qualif|appointment/i, bidding: /present|proposal|decision/i, submitted: /contract|negotiat/i, won: /closed.?won|won/i, lost: /closed.?lost|lost/i,
};
const SALESFORCE_STAGE: Record<BidStage, string> = {
  qualifying: 'Qualification', bidding: 'Proposal/Price Quote', submitted: 'Negotiation/Review', won: 'Closed Won', lost: 'Closed Lost',
};

type Stage = { id: string; label: string };

/** HubSpot needs a real pipeline and stage id; read the account's pipelines once and remember them. */
async function hubspotPipeline(ctx: ActionCtx, stage: BidStage): Promise<{ pipeline: string; dealstage: string }> {
  const data = await ctx.exec('HUBSPOT_RETRIEVE_ALL_PIPELINES_FOR_SPECIFIED_OBJECT_TYPE', { objectType: 'deals' });
  const pipelines = (deepFindArray(data, ['results']) ?? []) as { id: string; label?: string; stages?: Stage[] }[];
  const pipe = pipelines.find((p) => p.id === (ctx.meta.config?.pipeline as string | undefined)) ?? pipelines.find((p) => p.id === 'default') ?? pipelines[0];
  if (!pipe?.stages?.length) throw new ActionError('HubSpot returned no deal pipeline', 'not_configured');
  const stages = [...pipe.stages];
  const hit = stages.find((s) => HUBSPOT_STAGE_WORDS[stage].test(`${s.label} ${s.id}`)) ?? stages[0]!;
  return { pipeline: pipe.id, dealstage: hit.id };
}

const isoDate = (v: unknown) => (v ? String(v).slice(0, 10) : undefined);
const amountStr = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : v ? String(v) : undefined);

export const hubspot: ProviderActions = {
  create_deal: {
    summary: 'Create a deal (stage, value, close date)',
    run: async (i, ctx) => {
      const { pipeline, dealstage } = await hubspotPipeline(ctx, (i.stage as BidStage) ?? 'qualifying');
      const data = await ctx.exec('HUBSPOT_CREATE_DEAL', {
        dealname: need(i.name, 'name'), pipeline, dealstage,
        ...(amountStr(i.amount) ? { amount: amountStr(i.amount) } : {}),
        ...(isoDate(i.close_date) ? { closedate: isoDate(i.close_date) } : {}),
        ...(i.description ? { description: String(i.description).slice(0, 4000) } : {}),
      });
      const id = deepFind(data, ['id', 'dealId', 'hs_object_id']);
      return { id, url: null, details: { pipeline, dealstage } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('HUBSPOT_GET_DEAL', { dealId: out.id }), ['dealname']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('HUBSPOT_ARCHIVE_DEALS', { inputs: [{ id: out.id }] }); },
    sample: () => ({ name: 'Pactovio connector test deal', amount: 12500, close_date: new Date(Date.now() + 30 * 86_400_000).toISOString(), stage: 'qualifying', description: 'Created by the Pactovio connector test.' }),
  },
  update_deal: {
    summary: 'Update stage, value or close date of a deal',
    run: async (i, ctx) => {
      const dealId = need(i.deal_id, 'deal_id');
      const props: Record<string, unknown> = {};
      if (i.stage) Object.assign(props, { dealstage: (await hubspotPipeline(ctx, i.stage as BidStage)).dealstage });
      if (amountStr(i.amount)) props.amount = amountStr(i.amount);
      if (isoDate(i.close_date)) props.closedate = isoDate(i.close_date);
      if (i.name) props.dealname = i.name;
      await ctx.exec('HUBSPOT_UPDATE_DEAL', { dealId, properties: props });
      return { id: String(dealId) };
    },
  },
  add_note: {
    summary: 'Attach a note to a deal',
    run: async (i, ctx) => {
      const data = await ctx.exec('HUBSPOT_CREATE_NOTE', {
        hs_timestamp: ctx.now().toISOString(), hs_note_body: String(need(i.body, 'body')).slice(0, 60_000),
        associations: [{ to: { id: String(need(i.deal_id, 'deal_id')) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }],
      });
      return { id: deepFind(data, ['id']) };
    },
  },
};

export const salesforce: ProviderActions = {
  create_opportunity: {
    summary: 'Create an opportunity (stage, value, close date)',
    run: async (i, ctx) => {
      const data = await ctx.exec('SALESFORCE_CREATE_OPPORTUNITY', {
        name: need(i.name, 'name'), close_date: need(isoDate(i.close_date), 'close_date'),
        stage_name: SALESFORCE_STAGE[(i.stage as BidStage) ?? 'qualifying'],
        ...(typeof i.amount === 'number' ? { amount: i.amount } : {}),
        ...(i.description ? { description: String(i.description).slice(0, 30_000) } : {}),
      });
      const id = deepFind(data, ['id', 'Id']);
      return { id, url: null };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('SALESFORCE_GET_OPPORTUNITY', { opportunity_id: out.id }), ['Name', 'name']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('SALESFORCE_DELETE_OPPORTUNITY', { opportunity_id: out.id }); },
    sample: () => ({ name: 'Pactovio connector test opportunity', amount: 12500, close_date: new Date(Date.now() + 30 * 86_400_000).toISOString(), stage: 'qualifying', description: 'Created by the Pactovio connector test.' }),
  },
  update_opportunity: {
    summary: 'Update stage, value or close date of an opportunity',
    run: async (i, ctx) => {
      const id = need(i.opportunity_id, 'opportunity_id');
      await ctx.exec('SALESFORCE_UPDATE_OPPORTUNITY', {
        opportunity_id: id,
        ...(i.stage ? { stage_name: SALESFORCE_STAGE[i.stage as BidStage] } : {}),
        ...(typeof i.amount === 'number' ? { amount: i.amount } : {}),
        ...(isoDate(i.close_date) ? { close_date: isoDate(i.close_date) } : {}),
        ...(i.next_step ? { next_step: String(i.next_step).slice(0, 255) } : {}),
      });
      return { id: String(id) };
    },
  },
  add_note: {
    summary: 'Attach a note to an opportunity',
    run: async (i, ctx) => {
      const data = await ctx.exec('SALESFORCE_CREATE_NOTE', { parent_id: need(i.opportunity_id ?? i.deal_id, 'opportunity_id'), title: String(i.title ?? 'Pactovio verdict').slice(0, 80), body: String(need(i.body, 'body')).slice(0, 30_000) });
      return { id: deepFind(data, ['id', 'Id']) };
    },
  },
};
