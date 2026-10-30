// Billing & usage: plans from the billing API (names exactly as the backend defines them), the
// credit pack, session caps and model spend, and API keys.
import { api, h, icon, fmt, toast, load, chip, empty } from '../ui.js';
import { meter, sectionHead } from './ops-kit.js';

export async function render(root, _p, ctx) {
  ctx.setCrumbs('Billing & usage');
  const plans = h('div');
  const usage = h('div');
  const keys = h('div.card');
  root.append(
    h('div.page-head', h('div', h('h1.title', 'Billing & usage'), h('div.sub', 'Credits pay for pack reads and spec matches. 1 credit = $0.40. Test mode: no real charges.'))),
    plans, sectionHead('Usage'), usage, sectionHead('API keys', h('a.small.muted', { href: '/v1/openapi.json', target: '_blank' }, 'OpenAPI ↗')), keys);

  load(plans, async () => {
    const b = await api('/billing');
    const list = b.plans || [];
    const pack = h('div.card.plan.pack',
      h('div.plan-name', 'Credit pack'), h('div.plan-price', '$40', h('span.small.muted', ' one-off')),
      h('div.small.ink2', '100 credits that never expire'), h('div.plan-spacer'),
      buyBtn('credits', 'Buy credits', 'secondary'));
    return h('div',
      h('div.plan-current.card', h('div', h('div.xs.muted', 'Current plan'), h('div.h4', planName(list, b.plan))),
        h('div', h('div.xs.muted', 'Credit balance'), h('div.h4.num', String(b.credits_balance ?? 0))),
        h('div', h('div.xs.muted', 'Status'), chip(b.status || 'active')),
        b.current_period_end ? h('div', h('div.xs.muted', 'Renews'), h('div.small', fmt.date(b.current_period_end))) : null,
        b.plan && b.plan !== 'free' ? h('button.btn.btn-secondary.btn-sm', { onclick: portal }, 'Manage billing') : null),
      h('div.plan-grid', list.map((p) => h(`div.card.plan${p.id === b.plan ? '.on' : ''}`,
        h('div.plan-name', p.name, p.id === b.plan ? h('span.chip.ok', { style: { marginLeft: '8px' } }, 'Current') : null),
        h('div.plan-price', p.price_minor ? `$${Math.round(p.price_minor / 100)}` : 'Free', p.price_minor ? h('span.small.muted', ' / month') : null),
        h('div.small.ink2', `${p.monthly_credits} credits a month`),
        h('ul.plan-feats', (p.features || []).map((f) => h('li', icon('check', 14), f))),
        h('div.plan-spacer'),
        p.id === b.plan || !p.price_minor ? h('button.btn.btn-secondary', { disabled: true }, p.id === b.plan ? 'Current plan' : 'Included') : buyBtn(p.id, `Choose ${p.name}`, 'primary'))), pack));
  });

  load(usage, async () => {
    const l = await api('/limits');
    const s = l.session || {}; const t = l.tavily || {}; const u = l.usage || {};
    const rows = (u.today || []).map((m) => h('tr', h('td.mono', String(m.model || '').split('/').pop()), h('td.r.num', String(m.calls ?? 0)),
      h('td.r.num', fmt.tokens(m.tokens_in)), h('td.r.num.muted', fmt.tokens(m.tokens_cached)), h('td.r.num', fmt.tokens(m.tokens_out)), h('td.r.num', fmt.usd(m.cost_usd))));
    return h('div',
      h('div.grid.g4',
        h('div.card.stat', meter('Pack reads this session', s.runs_used, s.runs_cap)),
        h('div.card.stat', meter('Buyer lookups this session', s.tavily_used, s.tavily_cap)),
        h('div.card.stat', meter('Buyer lookups today', t.day_used, t.day_cap)),
        h('div.card.stat', meter('Agent turns / minute', 0, s.agent_turns_per_min_cap, 'Per session cap'))),
      h('div.card', { style: { marginTop: '16px' } },
        h('div.usage-head', h('div', h('div.small', { style: { fontWeight: 510 } }, 'Model spend today'), h('div.xs.muted', 'NVIDIA Nemotron on Nebius Token Factory · prices are estimates')),
          h('div.num', { style: { fontSize: '22px', fontWeight: 550 } }, fmt.usd(u.cost_today_usd))),
        rows.length ? h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Model'), h('th.r', 'Calls'), h('th.r', 'Tokens in'), h('th.r', 'Cached'), h('th.r', 'Tokens out'), h('th.r', 'Cost'))), h('tbody', rows))) : h('div.empty', 'No model calls today.')));
  });

  load(keys, async () => {
    const { items = [] } = await api('/api-keys');
    return h('div',
      items.length ? h('table.table', h('thead', h('tr', h('th', 'Name'), h('th', 'Key'), h('th', 'Created'), h('th.r', 'Last used'))),
        h('tbody', items.map((k) => h('tr', h('td', k.name || '—'), h('td.mono', `${k.prefix || 'pk_'}…`), h('td.muted', fmt.date(k.created_at)), h('td.r.muted', k.last_used_at ? fmt.ago(k.last_used_at) : 'never'))))) : empty('No API keys', null),
      h('div.xs.muted', { style: { padding: '12px' } }, 'Keys for the shared demo workspaces are issued by the operator. Use a key with the REST API (/v1) or the MCP server (/mcp).'));
  });
}

function planName(list, id) { return (list.find((p) => p.id === id) || {}).name || id || '—'; }

function buyBtn(plan, label, kind) {
  const b = h(`button.btn.btn-${kind}`, { onclick: async () => {
    b.disabled = true;
    try {
      const r = await api('/billing/checkout', { method: 'POST', body: { plan } });
      const url = r?.checkout_url || r?.url || r?.payment_link;
      if (url) window.open(url, '_blank', 'noopener'); else toast('Checkout created');
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  } }, label);
  return b;
}

async function portal() {
  try { const r = await api('/billing/portal', { method: 'POST', body: {} }); if (r?.url) window.open(r.url, '_blank', 'noopener'); } catch (e) { toast(e.message); }
}
