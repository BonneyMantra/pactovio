// Connections: every connector by category with live status, plus the live event stream.
import { api, h, icon, chip, fmt, toast, load, empty } from '../ui.js';
import { logoTile, opt, confirmRow } from './ops-kit.js';

const CATS = [['email', 'Email'], ['chat', 'Chat'], ['crm', 'CRM'], ['files', 'Files'], ['calendar', 'Calendar'], ['projects', 'Projects'], ['signing', 'Signing'], ['accounting', 'Accounting']];
const READONLY = /^(watch_|unwatch_|get_|list_)/;

export async function render(root, _p, ctx) {
  ctx.setCrumbs('Connections');
  const head = h('div.page-head', h('div', h('h1.title', 'Connections'), h('div.sub', 'Where Pactovio listens for requests and where it files the work.')));
  const body = h('div');
  const events = h('div.events-list');
  root.append(head, h('div.cx-layout', body, h('aside.card.events-panel',
    h('div.events-head', h('span.live-dot.on'), h('span.small', { style: { fontWeight: 510 } }, 'Live events'), h('span.xs.muted', 'workspace stream')), events)));

  load(body, async () => {
    const { items = [] } = await api('/connectors');
    if (!items.length) return empty('No connectors', 'The catalogue is empty.');
    const connected = items.filter((c) => c.status === 'connected').length;
    head.querySelector('.sub').textContent = `${connected} connected · live-tested 30 Oct · drafts only, nothing sends without approval`;
    return h('div', CATS.map(([key, label]) => {
      const group = items.filter((c) => (c.category || '').toLowerCase() === key);
      if (!group.length) return null;
      return h('section.cx-section', h('div.cx-cat', label), h('div.cx-grid', group.map(cardFor)));
    }));
  }, 8);

  function cardFor(c) {
    const isOn = c.status === 'connected';
    const st = c.status === 'needs_work_account' ? chip('needs_work_account') : isOn ? chip('connected', 'Connected') : c.status === 'pending' ? chip('pending', 'Pending') : chip('available', 'Not connected');
    const foot = h('div.cx-foot');
    const card = h(`div.card.cx-card${isOn ? '.on' : ''}`,
      h('div.cx-top', logoTile(c.provider, 40, c.name), h('div', { style: { minWidth: 0, flex: 1 } }, h('div.h4', opt(c.name, c.provider)), h('div.xs.muted.clamp', isOn ? opt(c.account_label, 'Connected') : opt(c.description, ''))), st),
      h('div.small.ink2.cx-what', opt(c.what_it_does || c.description, '')),
      foot);
    if (isOn) {
      foot.append(h('span.xs.muted', c.connected_at ? `Since ${fmt.date(c.connected_at)}` : ''), h('span.spacer'));
      const action = (c.actions || []).find((a) => !READONLY.test(a));
      if (action) {
        const btn = h('button.btn.btn-secondary.btn-xs', { onclick: async () => {
          const ok = await confirmRow(foot, `Run “${action.replace(/_/g, ' ')}” on ${c.name}? This creates a real test record.`, 'Run test');
          if (!ok) return;
          btn.disabled = true;
          try { const r = await api(`/connectors/${c.provider}/test`, { method: 'POST', body: { action, input: {} } }); toast(`${c.name}: ${r?.ok === false ? 'test failed' : 'test passed'}`); }
          catch (e) { toast(e.status === 429 ? 'Test actions are capped per hour.' : e.message); }
          finally { btn.disabled = false; }
        } }, icon('bolt', 14), 'Test');
        foot.append(btn);
      }
    } else if (c.status !== 'needs_work_account') {
      foot.append(h('span.spacer'), h('button.btn.btn-primary.btn-xs', { onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await api(`/connectors/${c.provider}/connect`, { method: 'POST', body: { redirect_to: `${location.origin}/app#/connections` } }); if (r?.redirect_url) location.href = r.redirect_url; }
        catch (err) { toast(err.status === 403 ? 'This demo workspace is shared, so connections are managed by the operator.' : err.message); }
        finally { e.currentTarget && (e.currentTarget.disabled = false); }
      } }, 'Connect'));
    }
    return card;
  }

  // Live events: the workspace SSE stream (each domain event as it happens), newest first.
  let es = null;
  const seed = await api('/events?limit=12').catch(() => ({ items: [] }));
  const push = (ev) => {
    events.querySelector('.empty')?.remove();
    events.prepend(h('div.event-row.fade-in', h('span.mono.ev-type', ev.type), h('span.xs.muted', fmt.ago(ev.at)), h('div.xs.ink2.clamp', summary(ev))));
    while (events.children.length > 30) events.lastChild.remove();
  };
  (seed.items || []).slice().reverse().forEach(push);
  if (!events.children.length) events.append(h('div.empty', 'Waiting for events…'));
  try {
    es = new EventSource('/api/events/stream');
    es.onmessage = (e) => { try { push(JSON.parse(e.data)); } catch { /* skip */ } };
    ['run.step', 'run.completed', 'answer.drafted', 'intake.created', 'intake.classified', 'tender.matched', 'verdict.ready', 'quote.ready', 'connector.action', 'audit.completed'].forEach((t) => es.addEventListener(t, (e) => { try { push(JSON.parse(e.data)); } catch { /* skip */ } }));
  } catch { /* stream optional */ }
  return () => { if (es) es.close(); };
}

function summary(ev) {
  const p = ev.payload || {};
  return String(summaryRaw(p)).replace(/"/g, '');
}

function summaryRaw(p) {
  return p.purpose || p.title || p.subject || p.question_ref && `Answer ${p.question_ref}${p.lot ? ` · lot ${p.lot}` : ''}` || (p.cost_usd != null ? `Run finished · $${Number(p.cost_usd).toFixed(2)}` : '') || p.provider || p.status || '';
}
