// Quote or design request detail: ids starting dsg_ are design requests, quo_ are quotes.
import { load } from '../ui.js';
import { renderDesign } from './design-view.js';
import { renderQuote } from './quote-doc.js';

export async function render(root, { id }, ctx) {
  const isDesign = String(id).startsWith('dsg_');
  ctx.setCrumbs('Quotes', isDesign ? 'Design request' : 'Quote');
  load(root, () => (isDesign ? renderDesign(id, ctx) : renderQuote(id, ctx)), 8);
}
