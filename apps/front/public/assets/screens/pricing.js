// Pricing, inside the app: the plans exactly as the billing backend defines them, plus what a credit buys.
import { api, h, fmt, icon, load, empty } from '../ui.js';

const CREDIT_USES = [
  ['Pack read up to 120 pages', '1 credit'], ['Pack read up to 400 pages', '2 credits'], ['Pack read over 400 pages', '4 credits'],
  ['Design request match', '1 credit'], ['Buyer research refresh', '1 credit'], ['Email triage, drafts, agent chat, connectors', 'Included'],
];

function planCard(p, current) {
  const on = p.id === current;
  return h('div.card', { style: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: on ? '0 0 0 1.5px var(--ink)' : undefined } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('div.h4', p.name), on ? h('span.chip.ok', 'Current plan') : null),
    h('div', h('span', { style: { fontSize: '28px', fontWeight: 550, letterSpacing: '-0.03em' } }, p.price_minor ? fmt.money(p.price_minor, p.currency) : 'Free'), p.price_minor ? h('span.small.muted', ' / month') : null),
    h('div.small.muted', `${p.monthly_credits} credits a month`),
    h('ul', { style: { margin: '4px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '6px' } }, (p.features || []).map((f) => h('li.small', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, icon('check', 14), f))),
    h('div', { style: { marginTop: 'auto', paddingTop: '8px' } }, on ? null : h('a.btn.btn-secondary.btn-sm', { href: '#/settings' }, p.price_minor ? `Choose ${p.name}` : 'Use Scout')));
}

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Pricing');
  root.append(h('div.page-head', h('div', h('h1.title', 'Pricing'), h('div.sub', 'Prices in USD. One credit is $0.40. Payments are handled by Dodo Payments (test mode in this demo).'))));
  const body = h('div');
  root.append(body);
  await load(body, async () => {
    const b = ctx.billing || await api('/billing');
    const plans = b.plans || [];
    if (!plans.length) return empty('Plans unavailable', 'The billing service did not return any plans.');
    return h('div',
      h('div.grid.g3', plans.map((p) => planCard(p, b.plan))),
      h('div.section-title', h('h3', 'Credit pack')),
      h('div.card', { style: { padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
        h('div', h('div.h4', '100 credits'), h('div.small.muted', 'Top up any plan; credits do not expire while the plan is active.')),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, h('span.h4', '$40'), h('a.btn.btn-secondary.btn-sm', { href: '#/settings' }, 'Buy credits'))),
      h('div.section-title', h('h3', 'What a credit buys')),
      h('div.card', h('table.table', h('tbody', CREDIT_USES.map(([k, v]) => h('tr', h('td.small', k), h('td.small.r', { style: { fontWeight: 510 } }, v)))))));
  }, 6);
}
