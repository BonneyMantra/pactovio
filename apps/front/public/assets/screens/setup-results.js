// Today: setup progress and the records onboarding actually saved. Every tile is filled from an API response.
import { api, h, icon, fmt } from '../ui.js';
import { sectionTitle } from './work-kit.js';

const STAGES = { about: 'About you', company: 'Company', goals: 'Priorities', result: 'First result', connect: 'Tools', ready: 'Ready' };

function tile(label, value, href, hint) {
  return h(href ? 'a.card.stat.wk-stat' : 'div.card.stat.wk-stat', href ? { href } : null,
    h('div.k', label), h('div.v', value), hint ? h('div.xs.muted', hint) : null);
}

export function setupPending(setup) {
  return !!setup && setup.setup?.version === 2 && !setup.setup.completed_at;
}

export function setupPanel(ctx) {
  const s = ctx.setup;
  if (!s || s.setup?.version !== 2) return null;
  const wrap = h('div.setup-today');
  if (setupPending(s)) {
    wrap.append(h('section.card.setup-continue',
      h('div', h('span.access-step', 'SETUP IN PROGRESS'), h('h2.h3', 'Continue setup'),
        h('p.small.ink2', `Next: ${STAGES[s.setup.stage] || 'About you'}. Get matched tenders, a priced quote and tracked deadlines.`)),
      h('a.btn.btn-primary', { href: '#/setup' }, 'Continue setup', icon('arrow'))));
  }
  const r = s.results || {};
  if (!Object.keys(r).length) return wrap;
  const grid = h('div.grid.g4.wk-stats', h('div.card.stat.wk-stat', h('div.k', 'Loading setup results…')));
  wrap.append(sectionTitle('Your setup results', setupPending(s) ? null : h('a.small.muted', { href: '#/setup' }, 'Review setup')), grid);
  fill(grid, r);
  return wrap;
}

async function fill(grid, r) {
  const [products, deadlines, quote] = await Promise.allSettled([
    api('/products'),
    api('/onboarding/deadlines'),
    r.quotes?.quote_id ? api(`/quotes/${encodeURIComponent(r.quotes.quote_id)}`) : Promise.resolve(null),
  ]);
  const tiles = [];
  if (r.opportunities) tiles.push(tile('Opportunities', String(r.opportunities.count ?? 0), '#/setup', r.opportunities.at ? `Searched ${fmt.date(r.opportunities.at)}` : null));
  tiles.push(products.status === 'fulfilled'
    ? tile('Products', String(products.value?.items?.length ?? 0), '#/catalogue', 'In your catalogue')
    : tile('Products', '—', '#/catalogue', 'Could not load'));
  if (deadlines.status === 'fulfilled') {
    const open = (deadlines.value?.items || []).filter((d) => d.status !== 'done' && d.due_at >= new Date().toISOString().slice(0, 10))
      .sort((a, b) => a.due_at.localeCompare(b.due_at));
    tiles.push(tile('Deadlines', String(open.length), null, open[0] ? `Next: ${open[0].title} · ${fmt.date(open[0].due_at)}` : 'None upcoming'));
  } else tiles.push(tile('Deadlines', '—', null, 'Could not load'));
  if (r.quotes?.quote_id) {
    const q = quote.status === 'fulfilled' ? quote.value : null;
    tiles.push(tile('Quote', q ? fmt.money(q.total_minor, q.currency) : 'Saved', `#/quotes/${encodeURIComponent(r.quotes.quote_id)}`, q ? `Priced ${fmt.date(r.quotes.at || q.created_at)}` : 'Open quote'));
  }
  grid.replaceChildren(...tiles);
}
