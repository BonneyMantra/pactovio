import { endpoints, HttpError, type DesignRequest, type Product } from '@pactovio/contracts';
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
  r.stub(endpoints.matchDesignRequest, 'quote.matchDesignRequest');
  r.stub(endpoints.quoteDesignRequest, 'quote.createQuote');
  r.on(endpoints.listProducts, async ({ db, workspaceId }) => ({
    items: await rows<Product>(db, 'SELECT * FROM products WHERE workspace_id = ? ORDER BY family, sku', workspaceId),
  }));
};
