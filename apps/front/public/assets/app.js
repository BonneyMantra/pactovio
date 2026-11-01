// App shell: sidebar (one identity block at the bottom), top bar and hash router. Each screen module exports
// `render(root, params, ctx)` that fills `root` and may return a cleanup function. Phones get a slide-in drawer.
import { api, h, icon, toast } from './ui.js';
import { session as customerSession, logout, friendlyError } from './customer-api.js';
import { gateFrame, leaveGate, gateLayout, gateError, renderAuth } from './access.js';
import { renderOnboarding } from './onboarding.js';
import { clearCompanyDraft } from './company-form.js';
import { rememberSetupReturn, restoreSetupReturn, clearSetupReturn } from './onboarding-return.js';

const NAV = [
  { id: 'today', label: 'Today', icon: 'home', mod: 'today' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', mod: 'inbox' },
  { id: 'tenders', label: 'Tenders', icon: 'tender', mod: 'tenders' },
  { id: 'quotes', label: 'Quotes', icon: 'quote', mod: 'quotes' },
  { id: 'agent', label: 'Agent', icon: 'agent', mod: 'agent' },
  { group: 'Workspace' },
  { id: 'connections', label: 'Connections', icon: 'plug', mod: 'connections' },
  { id: 'evidence', label: 'Evidence', icon: 'evidence', mod: 'evidence' },
  { id: 'catalogue', label: 'Catalogue', icon: 'quote', mod: 'catalogue' },
  { id: 'company', label: 'Company settings', icon: 'settings', mod: 'company' },
  { id: 'settings', label: 'Billing & usage', icon: 'card', mod: 'settings' },
  { group: 'Help' },
  { id: 'how', label: 'How it works', icon: 'spark', mod: 'how' },
  { id: 'pricing', label: 'Pricing', icon: 'quote', mod: 'pricing' },
  { id: 'help', label: 'Help', icon: 'search', mod: 'help' },
];

// #/tenders/tnd_1 -> { section: 'tenders', id: 'tnd_1' }; detail modules are `<section>-detail`.
function parse() {
  const parts = location.hash.split('?')[0].replace(/^#\/?/, '').split('/').filter(Boolean);
  return { section: parts[0] || 'today', id: parts[1] ? decodeURIComponent(parts[1]) : null, rest: parts.slice(2) };
}

const ctx = { session: null, billing: null, counts: {}, setCrumbs, refreshCounts };
let cleanup = null, gateCleanup = null, generation = 0, ready = false;

function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'P'; }

function planName() {
  const b = ctx.billing;
  if (!b) return null;
  return (b.plans || []).find((p) => p.id === b.plan)?.name || b.plan || null;
}

function closeMenus() { document.querySelectorAll('.pv-menu').forEach((m) => m.remove()); }

async function openIdentityMenu(anchor) {
  if (document.querySelector('.pv-menu')) { closeMenus(); return; }
  const list = h('div.pv-menu-list', h('div.xs.muted', { style: { padding: '6px 10px' } }, 'Loading workspaces…'));
  const menu = h('div.pv-menu', { role: 'menu' },
    h('div.pv-menu-head.xs.muted', 'Switch workspace'), list, h('div.pv-menu-sep'),
    h('a.pv-menu-item', { href: '#/settings', role: 'menuitem' }, icon('card'), 'Billing & usage'),
    h('a.pv-menu-item', { href: '#/company', role: 'menuitem' }, icon('settings'), 'Company settings'),
    h('a.pv-menu-item', { href: '#/help', role: 'menuitem' }, icon('search'), 'Help'),
    h('div.pv-menu-sep'), h('div.xs.ink2', { style: { padding: '8px 10px', overflowWrap: 'anywhere' } }, ctx.session?.user?.email || ''),
    h('button.pv-menu-item', { type: 'button', role: 'menuitem', onclick: signOut }, icon('out'), 'Sign out'));
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('a, button')];
    if (e.key === 'Escape') { closeMenus(); anchor.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); items[(items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  });
  anchor.parentElement.appendChild(menu);
  menu.querySelector('a, button')?.focus();
  try {
    const items = (await api('/workspaces')).items || [];
    list.replaceChildren(...items.map((w) => h('button.pv-menu-item', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(w.id === ctx.session?.workspace_id),
      onclick: async () => { try { await api('/workspaces/switch', { method: 'POST', body: { workspace_id: w.id } }); location.reload(); } catch { closeMenus(); } },
    }, h('span.avatar.pv-av-sm', initials(w.name)), h('span.pv-menu-txt', String(w.name || w.id).replace(/ \(Sample company\)$/, '')),
      w.id === ctx.session?.workspace_id ? icon('check', 14) : null)));
  } catch { list.replaceChildren(h('div.xs.muted', { style: { padding: '6px 10px' } }, 'Could not load workspaces')); }
}

function renderSide(active) {
  const side = document.getElementById('side');
  const ws = ctx.session?.workspace;
  const plan = planName();
  const idBtn = h('button.foot.pv-identity', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); openIdentityMenu(idBtn); } },
    h('span.avatar', initials(ws?.name)),
    h('div', { style: { minWidth: 0, flex: 1, textAlign: 'left' } },
      h('div.small', { style: { fontWeight: 510, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ws?.name || 'Workspace'),
      h('div.xs.muted', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, plan ? h('span.chip.outline.pv-plan', plan) : null, ws?.segment ? `${ws.segment[0].toUpperCase()}${ws.segment.slice(1)}` : '')),
    icon('down', 14));
  side.replaceChildren(
    h('a.brand', { href: '/' }, h('img', { src: '/assets/brand/mark.svg', alt: '', width: 24, height: 24, style: { display: 'block' } }), 'Pactovio'),
    h('nav.pv-nav', ...NAV.map((n) => n.group
      ? h('div.group', n.group)
      : h(`a.nav-item${active === n.id ? '.on' : ''}`, { href: `#/${n.id}` }, icon(n.icon), n.label, ctx.counts[n.id] ? h('span.count', String(ctx.counts[n.id])) : null))),
    h('div.pv-idwrap', idBtn),
  );
}

function setDrawer(open) {
  document.body.classList.toggle('pv-drawer-open', open);
  const bd = document.querySelector('.pv-backdrop');
  if (open && !bd) document.body.appendChild(h('div.pv-backdrop', { onclick: () => setDrawer(false) }));
  if (!open && bd) bd.remove();
}

function setCrumbs(...items) {
  const bar = document.getElementById('topbar');
  const ws = ctx.session?.workspace?.name;
  bar.replaceChildren(
    h('button.btn.btn-ghost.btn-sm.pv-menu-btn', { type: 'button', 'aria-label': 'Open navigation', onclick: () => setDrawer(true) }, icon('quote')),
    h('div.crumbs', ws ? h('span.pv-crumb-ws', ws) : null, ...items.flatMap((it, i) => [h(`span${i === 0 && !ws ? '' : ''}`, '/'), typeof it === 'string' ? h('b', it) : it])),
    h('div.spacer'),
    h('a.btn.btn-ghost.btn-sm', { href: '#/agent', title: 'Ask the agent' }, icon('spark'), h('span.pv-hide-sm', 'Ask Pactovio')),
  );
}

async function refreshCounts() {
  try {
    const t = await api('/today');
    ctx.counts = { inbox: t.counts?.open_intakes || 0, tenders: t.counts?.new_matches || 0, agent: t.counts?.approvals_pending || 0 };
  } catch { /* counts are decoration */ }
}

async function route() {
  if (!ready || !ctx.session) return;
  const current = ++generation;
  const { section, id, rest } = parse();
  const nav = NAV.find((n) => n.id === section) || NAV[0];
  setDrawer(false);
  closeMenus();
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
    if (current !== generation || !ready) return;
    const dispose = (await mod.render(root, { id, rest }, ctx)) || null;
    if (current !== generation || !ready) { dispose?.(); return; }
    cleanup = dispose;
  } catch (e) {
    root.replaceChildren(h('div.error-box', `This screen failed to load: ${e.message}`));
  }
}

function clearWorkspace() {
  ready = false; generation++;
  cleanup?.(); cleanup = null; gateCleanup?.(); gateCleanup = null;
  setDrawer(false); closeMenus();
  ctx.session = null; ctx.billing = null; ctx.counts = {};
  ['side', 'topbar', 'view'].forEach((id) => document.getElementById(id).replaceChildren());
  document.querySelectorAll('.toast-wrap').forEach((node) => node.remove());
}

function authenticate(notice = '') {
  clearWorkspace();
  gateCleanup = renderAuth(gateFrame(), boot, notice);
}

async function signOut() {
  try { await logout(); authenticate('You have signed out.'); clearCompanyDraft(); clearSetupReturn(); }
  catch (error) { toast(`Could not sign out. ${friendlyError(error)}`); }
}

async function boot() {
  clearWorkspace();
  const current = generation;
  const gate = gateFrame();
  gateLayout(gate, h('section.card.access-card', h('p.ink2', { role: 'status' }, 'Opening your private workspace…')));
  try {
    const session = await customerSession();
    if (current !== generation) return;
    ctx.session = session;
    if (!session.onboarding_complete) {
      rememberSetupReturn(session.workspace_id);
      const dispose = await renderOnboarding(gate, session, boot, signOut);
      if (current !== generation) dispose(); else gateCleanup = dispose;
      return;
    }
    ctx.billing = await api('/billing').catch(() => null);
    if (current !== generation) return;
    await refreshCounts();
    if (current !== generation) return;
    restoreSetupReturn(session.workspace_id);
    leaveGate(); ready = true; route();
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) authenticate();
    else gateError(gate, error, boot);
  }
}
window.addEventListener('hashchange', () => { if (ready) route(); });
window.addEventListener('pv:session-expired', () => {
  if (ctx.session || ready) authenticate('Your session expired. Sign in again to continue.');
});
document.addEventListener('click', (e) => { if (!e.target.closest('.pv-menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenus(); setDrawer(false); } });
boot();
