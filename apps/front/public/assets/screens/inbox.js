// Inbox: every intake (email, upload, scan) with the Lightning model's classification, filterable by door.
import { api, h, icon, fmt, empty, errorBox, skeleton } from '../ui.js';
import { doorOf, doorChip, sourceMark, senderName, tabs } from './work-kit.js';

const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'rfp', label: 'RFP / RFQ' },
  { id: 'design', label: 'Design' }, { id: 'tender', label: 'Tender' }, { id: 'ignored', label: 'Ignored' },
];

function row(it) {
  const conf = it.classification?.confidence;
  return h('a.wk-mail', { href: `#/inbox/${encodeURIComponent(it.id)}` },
    sourceMark(it.source, 32),
    h('div.wk-mail-main',
      h('div.wk-mail-top', h('span.wk-sender', senderName(it.sender) || it.source || 'Unknown sender'), h('span.xs.muted.num', fmt.ago(it.received_at))),
      h('div.wk-mail-subj', it.title || '(no subject)'),
      h('div.xs.muted.wk-ellipsis', it.classification?.reason || (it.status === 'processing' ? 'Classifying with Nemotron Lightning…' : '—'))),
    h('div.wk-mail-side', doorChip(it), conf != null ? h('span.xs.muted.num', `${Math.round(conf * 100)}% sure`) : null));
}

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Inbox');
  root.append(h('div.page-head',
    h('div', h('h1.title', 'Inbox'), h('div.sub', 'RFQs, RFPs, design requests and tenders, classified the moment they arrive.')),
    h('a.btn.btn-primary.btn-sm', { href: '#/inbox/new' }, icon('inbox'), 'New intake')));
  const bar = h('div');
  const list = h('div.card.wk-list');
  root.append(bar, list);
  list.append(skeleton(6));
  let items = [];
  try { items = (await api('/intakes')).items || []; } catch (e) { list.replaceChildren(errorBox(e)); return; }
  let active = 'all';
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, f.id === 'all' ? items.length : items.filter((i) => doorOf(i) === f.id).length]));
  const draw = () => {
    bar.replaceChildren(tabs(FILTERS.map((f) => ({ ...f, count: counts[f.id] })), active, (id) => { active = id; draw(); }));
    const shown = items.filter((i) => active === 'all' || doorOf(i) === active)
      .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
    list.replaceChildren(...(shown.length ? shown.map(row) : [empty(active === 'all' ? 'No intakes yet' : 'Nothing in this view', 'Forward an RFQ to the connected inbox or paste one with New intake.')]));
  };
  draw();
  const poll = setInterval(async () => {
    try {
      const next = (await api('/intakes')).items || [];
      if (next.length !== items.length || next.some((n, i) => n.status !== items[i]?.status)) {
        items = next;
        for (const f of FILTERS) counts[f.id] = f.id === 'all' ? items.length : items.filter((i) => doorOf(i) === f.id).length;
        draw();
      }
    } catch { /* keep the last good list */ }
  }, 15000);
  return () => clearInterval(poll);
}
