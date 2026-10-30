// App shell: sidebar, top bar and hash router. Each screen module exports
// `render(root, params, ctx)` that fills `root` and may return a cleanup function.
import { api, h, icon } from './ui.js';

const NAV = [
  { id: 'today', label: 'Today', icon: 'home', mod: 'today' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', mod: 'inbox' },
  { id: 'tenders', label: 'Tenders', icon: 'tender', mod: 'tenders' },
  { id: 'quotes', label: 'Quotes', icon: 'quote', mod: 'quotes' },
  { id: 'agent', label: 'Agent', icon: 'agent', mod: 'agent' },
  { group: 'Workspace' },
  { id: 'connections', label: 'Connections', icon: 'plug', mod: 'connections' },
  { id: 'evidence', label: 'Evidence', icon: 'evidence', mod: 'evidence' },
  { id: 'settings', label: 'Billing & usage', icon: 'card', mod: 'settings' },
];

// #/tenders/tnd_1 -> { section: 'tenders', id: 'tnd_1' }; detail modules are `<section>-detail`.
function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { section: parts[0] || 'today', id: parts[1] ? decodeURIComponent(parts[1]) : null, rest: parts.slice(2) };
}

const ctx = { session: null, counts: {}, setCrumbs, refreshCounts };
let cleanup = null;

function renderSide(active) {
  const side = document.getElementById('side');
  const ws = ctx.session?.workspace;
  side.replaceChildren(
    h('a.brand', { href: '/' }, h('img', { src: '/assets/brand/mark.svg', alt: '', width: 24, height: 24, style: { display: 'block' } }), 'Pactovio'),
    ...NAV.map((n) => n.group
      ? h('div.group', n.group)
      : h(`a.nav-item${active === n.id ? '.on' : ''}`, { href: `#/${n.id}` }, icon(n.icon), n.label, ctx.counts[n.id] ? h('span.count', String(ctx.counts[n.id])) : null)),
    h('div.foot', h('span.avatar', initials(ws?.name)), h('div', { style: { minWidth: 0 } },
      h('div.small', { style: { fontWeight: 510, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ws?.name || 'Workspace'),
      h('div.xs.muted', ws?.segment ? `${ws.segment[0].toUpperCase()}${ws.segment.slice(1)} supplier` : ''))),
  );
}

function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'P'; }

function setCrumbs(...items) {
  const bar = document.getElementById('topbar');
  const ws = ctx.session?.workspace?.name;
  bar.replaceChildren(
    h('div.crumbs', ws ? h('span', ws) : null, ...items.flatMap((it) => [h('span', '/'), typeof it === 'string' ? h('b', it) : it])),
    h('div.spacer'),
    h('a.btn.btn-ghost.btn-sm', { href: '#/agent', title: 'Ask the agent' }, icon('spark'), 'Ask Pactovio'),
  );
}

async function refreshCounts() {
  try {
    const t = await api('/today');
    ctx.counts = { inbox: t.counts?.open_intakes || 0, tenders: t.counts?.new_matches || 0, agent: t.counts?.approvals_pending || 0 };
  } catch { /* counts are decoration */ }
}

async function route() {
  const { section, id, rest } = parse();
  const nav = NAV.find((n) => n.id === section) || NAV[0];
  renderSide(nav.id);
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const view = document.getElementById('view');
  const root = h('div.page.fade-in');
  view.replaceChildren(root);
  setCrumbs(nav.label);
  window.scrollTo(0, 0);
  const modName = id ? `${nav.mod}-detail` : nav.mod;
  try {
    const mod = await import(`./screens/${modName}.js`);
    cleanup = (await mod.render(root, { id, rest }, ctx)) || null;
  } catch (e) {
    root.replaceChildren(h('div.error-box', `This screen failed to load: ${e.message}`));
  }
}

async function boot() {
  try { ctx.session = await api('/session'); } catch { ctx.session = null; }
  await refreshCounts();
  window.addEventListener('hashchange', route);
  route();
}
boot();
