// Quotes: inbound design requests and the quotes drafted from them.
import { api, h, fmt, chip, empty, load, icon } from '../ui.js';
import { opt, money, sectionHead } from './ops-kit.js';

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Quotes');
  const requests = h('div.card');
  const quotes = h('div.card');
  root.append(
    h('div.page-head',
      h('div', h('h1.title', 'Quotes'), h('div.sub', 'Design requests matched against your datasheets, and the quotes Pactovio drafted from them.')),
      h('a.btn.btn-secondary', { href: '#/agent' }, icon('spark'), 'New request from text')),
    sectionHead('Design requests'), requests,
    sectionHead('Quotes'), quotes,
  );

  load(requests, async () => {
    const { items = [] } = await api('/design-requests');
    if (!items.length) return empty('No design requests yet', 'Add your products and datasheets, then bring in a customer request manually or through a connected inbox.', h('a.btn.btn-secondary', { href: '#/catalogue' }, 'Set up your catalogue'));
    return h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Customer'), h('th', 'Request'), h('th', 'Matched'), h('th.r', 'Status'))),
      h('tbody', items.map((d) => {
        const reqs = Array.isArray(d.requirements) ? d.requirements : [];
        const met = reqs.filter((r) => r?.result?.status === 'MET').length;
        return h('tr.click', { onclick: () => { location.hash = `#/quotes/${d.id}`; } },
          h('td', h('div', { style: { fontWeight: 510 } }, opt(d.customer))),
          h('td', h('div.clamp', opt(d.subject || d.title))),
          h('td.num.muted', reqs.length ? `${met}/${reqs.length} met` : '—'),
          h('td.r', chip(d.status || 'new')));
      }))));
  });

  load(quotes, async () => {
    const [{ items = [] }, drs] = await Promise.all([api('/quotes'), api('/design-requests').catch(() => ({ items: [] }))]);
    const who = new Map((drs.items || []).map((d) => [d.id, d.customer]));
    if (!items.length) return empty('No quotes yet', 'Add your real product prices, then open a design request and choose “Draft quote”.', h('a.btn.btn-secondary', { href: '#/catalogue' }, 'Manage catalogue'));
    return h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Quote'), h('th', 'For'), h('th', 'Lines'), h('th', 'Status'), h('th', 'Valid until'), h('th.r', 'Total'))),
      h('tbody', items.map((q) => h('tr.click', { onclick: () => { location.hash = `#/quotes/${q.id}`; } },
        h('td.mono', quoteNo(q)),
        h('td', opt(q.customer || who.get(q.design_request_id) || (q.tender_id ? 'Tender response' : null))),
        h('td.num.muted', String(Array.isArray(q.lines) ? q.lines.length : 0)),
        h('td', chip(q.status || 'draft')),
        h('td.muted', q.valid_until ? fmt.date(q.valid_until) : '—'),
        h('td.r.num', { style: { fontWeight: 510 } }, money(q.total_minor, q.currency)))))));
  });
}

export function quoteNo(q) { return `Q-${String(q?.id || '').slice(-6).toUpperCase()}`; }
