import { chargeCredits, CREDIT_COSTS, refundCredits } from '@pactovio/billing';
import { endpoints, HttpError, newId, type DesignRequest, type Product } from '@pactovio/contracts';
import { createQuote, matchDesignRequest, startRun } from '@pactovio/quote';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listDesignRequests, async ({ db, workspaceId }) => ({
    items: await rows<DesignRequest>(db, 'SELECT * FROM design_requests WHERE workspace_id = ? ORDER BY id', workspaceId),
  }));
  r.on(endpoints.getDesignRequest, async ({ db, workspaceId, params }) => {
    const d = await one<DesignRequest>(db, 'SELECT * FROM design_requests WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!d) throw new HttpError(404, 'Design request not found', 'not_found');
    return d;
  });
  r.on(endpoints.matchDesignRequest, async ({ env, db, workspaceId, params }) => {
    const d = await one<DesignRequest>(db, 'SELECT * FROM design_requests WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!d) throw new HttpError(404, 'Design request not found', 'not_found');
    // 1 credit per design match on real workspaces (sample workspaces are never charged); returned when the match fails.
    const ref = `design_match:${newId('run')}`;
    await chargeCredits(env, workspaceId, CREDIT_COSTS.design_match, 'design_match', ref);
    const run = await startRun(db, workspaceId, params.id);
    try {
      const out = await matchDesignRequest(env, params.id, { onStep: run.onStep });
      await run.finish('completed');
      return out;
    } catch (e) {
      await refundCredits(env, workspaceId, CREDIT_COSTS.design_match, 'design_match_refund', `refund:${ref}`).catch(() => undefined);
      await run.fail(e);
      await run.finish('failed');
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, e instanceof Error && /NEBIUS_API_KEY/.test(e.message) ? 'Model access is not configured' : 'The model call failed; try again', 'upstream');
    }
  });
  r.on(endpoints.quoteDesignRequest, async ({ env, workspaceId, params, body }) =>
    createQuote(env, {
      workspaceId, designRequestId: params.id, productIds: body.product_ids, qty: body.qty,
      buyer: { country: body.buyer_country, b2b: body.b2b, vat_registered: body.vat_registered },
    }));
  r.on(endpoints.listProducts, async ({ db, workspaceId }) => ({
    items: await rows<Product>(db, 'SELECT * FROM products WHERE workspace_id = ? ORDER BY family, sku', workspaceId),
  }));
};
