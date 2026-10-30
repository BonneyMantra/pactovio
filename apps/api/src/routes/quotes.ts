import { endpoints, HttpError, type Quote } from '@pactovio/contracts';
import { one, rows } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listQuotes, async ({ db, workspaceId }) => ({
    items: await rows<Quote>(db, 'SELECT * FROM quotes WHERE workspace_id = ? ORDER BY id', workspaceId),
  }));
  r.on(endpoints.getQuote, async ({ db, workspaceId, params }) => {
    const q = await one<Quote>(db, 'SELECT * FROM quotes WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!q) throw new HttpError(404, 'Quote not found', 'not_found');
    return q;
  });
  r.stub(endpoints.exportQuote, 'quote export');
};
