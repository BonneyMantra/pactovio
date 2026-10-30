import { endpoints, HttpError, type BuyerIntel } from '@pactovio/contracts';
import { one } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.getBuyer, async ({ db, params }) => {
    const b = await one<BuyerIntel>(db, 'SELECT * FROM buyer_intel WHERE buyer_key = ?', params.id);
    if (!b) throw new HttpError(404, 'No intel for this buyer yet. POST /buyers/{id}/refresh', 'not_found');
    return b;
  });
  r.stub(endpoints.refreshBuyer, 'engine.buyerIntel');
};
