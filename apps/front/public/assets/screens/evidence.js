// Evidence library: certificates, datasheets, company facts. Everything an answer or gate is allowed to cite.
import { api, h, icon, fmt, empty, errorBox, skeleton } from '../ui.js';
import { evidenceUpload } from '../evidence-upload.js';
import { dash, tabs } from './work-kit.js';

const KIND = { certificate: 'Certificates', datasheet: 'Datasheets', profile: 'Company', capability: 'Capabilities', financial: 'Financials', reference: 'References', insurance: 'Insurance', policy: 'Policies', case_study: 'Case studies', cv: 'CVs' };
const ONE = { certificate: 'Certificate', datasheet: 'Datasheet', profile: 'Company', capability: 'Capability', financial: 'Financial', reference: 'Reference', insurance: 'Insurance', policy: 'Policy', case_study: 'Case study', cv: 'CV' };
const nice = (k) => String(k || 'evidence').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function expiry(validTo) {
  if (!validTo) return null;
  const days = Math.ceil((new Date(validTo).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return null;
  const tone = days < 0 ? 'bad' : days < 90 ? 'warn' : 'ok';
  return h(`span.chip.${tone}`, h('span.dot'), days < 0 ? 'Expired' : `Valid to ${fmt.date(validTo)}`);
}

function card(e) {
  const src = e.meta && typeof e.meta === 'object' ? (e.meta.source_url || e.meta.datasheet_pdf || null) : null;
  const body = h('div.small.ink2.wk-clamp3', e.text || dash);
  return h('div.card.wk-ev', { onclick: () => body.classList.toggle('wk-clamp3') },
    h('div.wk-ev-top', h('span.chip.outline', ONE[e.kind] || nice(e.kind)), expiry(e.valid_to), h('span.wk-grow'), src ? h('a.xs.muted', { href: src, target: '_blank', rel: 'noopener', onclick: (ev) => ev.stopPropagation() }, 'Source', icon('out', 12)) : null),
    h('div.wk-ev-title', e.title || 'Untitled evidence'),
    h('div.xs.muted', [e.issuer, e.scope].filter(Boolean).join(' · ') || dash),
    body);
}

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Evidence');
  const upload = evidenceUpload(async () => { active = 'all'; await refresh(); }, () => refresh());
  root.append(h('div.page-head', h('div', h('h1.title', 'Evidence'), h('div.sub', 'The company documents Pactovio can cite in matching and drafts.')),
    h('button.btn.btn-primary', { onclick: () => { upload.element.scrollIntoView({ behavior: 'smooth', block: 'start' }); upload.focus(); } }, icon('clip'), 'Upload evidence')), upload.element);
  const bar = h('div');
  const grid = h('div.wk-evgrid');
  root.append(bar, grid);
  grid.append(skeleton(6));
  let items = [], kinds = [], active = 'all', disposed = false;
  async function refresh() {
    grid.replaceChildren(skeleton(4));
    try {
      const result = await api('/evidence?limit=200'); if (disposed) return;
      items = result.items || []; kinds = [...new Set(items.map((e) => e.kind).filter(Boolean))].sort(); draw();
    } catch (error) { if (!disposed) grid.replaceChildren(errorBox(error), h('button.btn.btn-secondary', { onclick: refresh }, 'Retry evidence list')); }
  }
  const draw = () => {
    bar.replaceChildren(tabs([{ id: 'all', label: 'All', count: items.length }, ...kinds.map((k) => ({ id: k, label: KIND[k] || nice(k), count: items.filter((e) => e.kind === k).length }))], active, (id) => { active = id; draw(); }));
    const shown = items.filter((e) => active === 'all' || e.kind === active);
    grid.replaceChildren(...(shown.length ? shown.map(card) : [empty('No evidence yet', 'Upload certificates, datasheets and references; Pactovio reads and indexes them.')]));
  };
  await refresh();
  return () => { disposed = true; upload.dispose(); };
}
