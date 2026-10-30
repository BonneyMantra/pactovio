// Tenders: every matched public tender with its fit score. Dismissed matches hidden unless asked for.
import { api, h, fmt, chip, empty, errorBox, skeleton } from '../ui.js';
import { dash, fitRing } from './work-kit.js';

function row({ tender: t, match: m }) {
  return h('tr.click', { onclick: () => { location.hash = `#/tenders/${encodeURIComponent(t.id)}`; } },
    h('td', h('div.wk-trow', fitRing(m?.fit_score, 34), h('div', { style: { minWidth: 0 } }, h('div.wk-ttl', t.title || 'Untitled tender'), h('div.xs.muted.wk-ellipsis', (t.cpv || []).slice(0, 3).join(' · ') || (t.source ? `via ${t.source}` : dash))))),
    h('td.small', t.buyer || dash, h('div.xs.muted', t.country || '')),
    h('td.r.num.small', t.value_eur ? fmt.moneyMajor(t.value_eur, 'EUR') : dash),
    h('td.small.num.wk-nowrap', t.deadline ? fmt.date(t.deadline) : dash, t.deadline ? h('div.xs.muted', fmt.until(t.deadline)) : null),
    h('td', chip(m?.status || 'new')));
}

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Tenders');
  let showAll = false;
  const toggle = h('button.pv-switch', { type: 'button', role: 'switch', 'aria-checked': 'false', onclick: () => { showAll = !showAll; toggle.setAttribute('aria-checked', String(showAll)); draw(); } },
    h('span.pv-switch-track', h('span.pv-switch-thumb')), h('span.small', 'Show dismissed'));
  root.append(h('div.page-head', h('div', h('h1.title', 'Tenders'), h('div.sub', 'Public tenders scored nightly against your capabilities, certificates and turnover.')), toggle));
  const box = h('div.card');
  root.append(box);
  box.append(h('div.wk-pad', skeleton(6)));
  let items = [];
  try { items = ((await api('/tenders')).items || []).filter((x) => x && x.tender); } catch (e) { box.replaceChildren(errorBox(e)); return; }
  const draw = () => {
    const shown = items.filter((x) => showAll || x.match?.status !== 'dismissed')
      .sort((a, b) => (b.match?.fit_score ?? -1) - (a.match?.fit_score ?? -1));
    box.replaceChildren(shown.length
      ? h('div.wk-scroll', h('table.table', h('thead', h('tr', h('th', 'Tender'), h('th', 'Buyer'), h('th.r', 'Value'), h('th', 'Deadline'), h('th', 'Status'))), h('tbody', shown.map(row))))
      : empty('No tenders matched yet', 'The nightly scan reads TED, eTenders and Find a Tender. Matches above 50 land here.'));
  };
  draw();
}
