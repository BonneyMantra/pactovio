// Agent: the 24x7 desk agent. Threads on the left, a streaming conversation on the right over the
// workspace WebSocket (HTTP fallback). State-changing tools arrive as action cards to confirm.
import { api, h, icon, toast, skeleton, errorBox } from '../ui.js';
import { messageEl, richText, toolGroup, actionCard } from './agent-thread.js';

const SUGGEST = ["What's on today?", 'Summarise the Met Éireann verdict', 'Draft a reply to the latest design request', 'Which connectors are live?'];

export async function render(root, _p, ctx) {
  ctx.setCrumbs('Agent');
  root.classList.add('agent-page');
  const state = { threads: [], current: null, ws: null, wsOpen: false, busy: false, live: null, cards: new Map(), closed: false };

  const list = h('div.thread-list');
  const feed = h('div.feed');
  const title = h('div.conv-title', 'Pactovio');
  const sub = h('div.xs.muted');
  const headRight = h('div', { style: { display: 'flex', gap: '6px' } });
  const ta = h('textarea', { rows: '1', placeholder: 'Ask about a tender, an RFQ or a quote…', 'aria-label': 'Message the agent' });
  const sendBtn = h('button.send', { title: 'Send', 'aria-label': 'Send' }, icon('send', 16));
  const chips = h('div.suggest', SUGGEST.map((s) => h('button.chip.outline', { onclick: () => send(s) }, s)));
  const dot = h('span.live-dot', { title: 'Connecting' });

  root.append(h('div.agent-win.card',
    h('div.agent-side',
      h('div.agent-side-head', h('span.small', { style: { fontWeight: 510 } }, 'Conversations'),
        h('button.btn.btn-ghost.btn-xs', { onclick: newThread, title: 'New conversation' }, icon('spark', 14), 'New')),
      list),
    h('div.agent-main',
      h('div.conv-head', h('div', { style: { minWidth: 0 } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, dot, title), sub), headRight),
      feed,
      h('div.composer-wrap', chips, h('div.composer', ta, h('span.xs.muted.hint', '↵ send · ⇧↵ new line'), sendBtn)))));

  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(160, ta.scrollHeight)}px`; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  sendBtn.addEventListener('click', () => send(ta.value));

  function setBusy(b) { state.busy = b; sendBtn.disabled = b; ta.disabled = false; feed.classList.toggle('busy', b); }
  const scroll = () => { feed.scrollTop = feed.scrollHeight; };

  function renderList() {
    list.replaceChildren(...state.threads.map((t) => h(`button.thread-item${t.id === state.current ? '.on' : ''}`, { onclick: () => open(t.id) },
      h('span', icon(t.id === 'thr_inbox' ? 'inbox' : 'agent', 14)), h('span.clamp', t.id === 'thr_inbox' ? 'Inbox · proactive' : t.title || 'New conversation'))));
  }

  async function loadThreads() {
    try { const r = await api('/agent/threads'); state.threads = r.items || []; } catch (e) { state.threads = [{ id: 'thr_inbox', title: 'Pactovio inbox' }]; toast(e.message); }
    renderList();
  }

  async function open(id) {
    state.current = id; state.live = null; renderList();
    const t = state.threads.find((x) => x.id === id);
    title.textContent = id === 'thr_inbox' ? 'Inbox' : (t?.title || 'New conversation');
    sub.textContent = id === 'thr_inbox' ? 'Proactive messages from tenders, email and runs. Cards wait for your decision.' : 'Private to this session';
    headRight.replaceChildren(...(id === 'thr_inbox' ? [h('button.btn.btn-secondary.btn-sm', { onclick: runDigest }, icon('clock', 14), 'Run digest')] : []));
    chips.style.display = id === 'thr_inbox' ? 'none' : '';
    feed.replaceChildren(skeleton(4));
    try {
      const r = await api(`/agent/threads/${id}/messages`);
      const items = r.items || [];
      feed.replaceChildren();
      if (!items.length) feed.append(welcome());
      items.forEach(append);
      scroll();
    } catch (e) { feed.replaceChildren(errorBox(e)); }
  }

  function welcome() {
    return h('div.welcome', h('span.agent-av.lg', icon('logo', 20)), h('div.h3', 'What can I take off your plate?'),
      h('div.muted', { style: { maxWidth: '440px', textAlign: 'center' } }, 'I read tenders, RFQs and design requests, check them against your evidence and datasheets, and ask before I change anything.'));
  }

  function append(msg) {
    feed.querySelector('.welcome')?.remove();
    const el = messageEl(msg);
    if (msg.pending_action) el.querySelector('.msg-col, .bubble')?.append(card(msg.pending_action));
    feed.append(el);
  }

  function card(action) {
    const c = actionCard(action, decide);
    state.cards.set(action.id, c);
    return c;
  }

  async function decide(id, decision) {
    if (state.wsOpen) { state.ws.send(JSON.stringify({ type: 'action_decision', action_id: id, decision })); return null; }
    return api(`/agent/actions/${id}`, { method: 'POST', body: { decision } });
  }

  function liveTurn() {
    if (state.live) return state.live;
    feed.querySelector('.welcome')?.remove();
    const tools = toolGroup([]);
    tools.el.style.display = 'none';
    const text = h('div.msg-text.streaming');
    const col = h('div.msg-col', h('div.msg-who', 'Pactovio', h('span.xs.muted', 'now')), h('div.msg-body', tools.el, text));
    feed.append(h('div.msg.assistant', h('span.agent-av', icon('logo', 14)), col));
    state.live = { raw: '', text, tools, col };
    return state.live;
  }

  async function send(content) {
    content = String(content || '').trim();
    if (!content || state.busy) return;
    ta.value = ''; ta.style.height = 'auto';
    if (state.current === 'thr_inbox') { state.current = null; feed.replaceChildren(); title.textContent = 'New conversation'; sub.textContent = 'Private to this session'; headRight.replaceChildren(); chips.style.display = ''; }
    append({ role: 'user', content, at: new Date().toISOString() });
    scroll(); setBusy(true);
    if (state.wsOpen) {
      state.ws.send(JSON.stringify({ type: 'user_message', content, ...(state.current ? { thread_id: state.current } : {}) }));
      liveTurn(); scroll();
      return;
    }
    try {
      const r = await api('/agent/messages', { method: 'POST', body: { content, ...(state.current ? { thread_id: state.current } : {}) } });
      if (!state.current) { state.current = r.thread_id; await loadThreads(); }
      (r.messages || []).filter((m) => m.role === 'assistant').forEach(append);
    } catch (e) { toast(e.status === 429 ? 'Easy there: the agent is rate-limited for a moment. Try again shortly.' : e.message); }
    setBusy(false); scroll();
  }

  async function newThread() {
    try { const t = await api('/agent/threads', { method: 'POST', body: {} }); state.threads.push(t); open(t.id); } catch (e) { toast(e.message); }
  }

  async function runDigest() {
    try { await api('/agent/digest', { method: 'POST', body: {} }); toast('Digest posted to the inbox'); open('thr_inbox'); } catch (e) { toast(e.message); }
  }

  function onFrame(f) {
    switch (f.type) {
      case 'thread':
        if (f.thread && !state.threads.some((t) => t.id === f.thread.id)) state.threads.push(f.thread);
        if (f.thread && state.current !== 'thr_inbox') { state.current = f.thread.id; title.textContent = f.thread.title || 'Conversation'; }
        renderList(); break;
      case 'assistant_delta': { const l = liveTurn(); l.raw += f.delta || ''; l.text.replaceChildren(richText(l.raw)); scroll(); break; }
      case 'tool_call': { const l = liveTurn(); l.tools.el.style.display = ''; l.tools.add({ call_id: f.call_id, name: f.name, input: f.input, status: f.status }); scroll(); break; }
      case 'approval_requested': {
        if (f.action && !state.cards.has(f.action.id)) {
          const mine = state.live && (!f.thread_id || f.thread_id === state.current);
          if (mine) state.live.col.append(card(f.action));
          else if (state.current === 'thr_inbox' || f.thread_id === state.current) feed.append(h('div.msg.assistant', h('span.agent-av', icon('logo', 14)), h('div.msg-col', h('div.msg-who', 'Pactovio'), card(f.action))));
          scroll();
        }
        break;
      }
      case 'action_result': {
        const c = f.action && state.cards.get(f.action.id);
        if (c) c.update(f.action);
        if (f.message) { feed.append(messageEl(typeof f.message === 'string' ? { role: 'assistant', content: f.message, at: new Date().toISOString() } : f.message)); scroll(); }
        break;
      }
      case 'assistant_message': {
        const m = f.message || {};
        if (state.live && m.thread_id !== 'thr_inbox') {
          state.live.text.classList.remove('streaming');
          if (m.content) state.live.text.replaceChildren(richText(m.content));
          if (m.pending_action && !state.cards.has(m.pending_action.id)) state.live.col.append(card(m.pending_action));
        } else if (m.thread_id === state.current) { append(m); }
        else if (m.thread_id === 'thr_inbox') toast('New message in the inbox');
        scroll(); break;
      }
      case 'done': state.live && state.live.text.classList.remove('streaming'); state.live = null; setBusy(false); break;
      case 'error':
        toast(f.code === 'rate_limited' ? 'Easy there: the agent is rate-limited for a moment.' : f.code === 'budget_exhausted' ? 'This session used its agent budget.' : (f.error || 'The agent hit an error'));
        if (state.live) { state.live.text.classList.remove('streaming'); if (!state.live.raw) state.live.text.replaceChildren(h('span.muted', 'No answer this time.')); }
        state.live = null; setBusy(false); break;
      default: break;
    }
  }

  function connect() {
    if (state.closed) return;
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/agent/ws`); } catch { return; }
    state.ws = ws;
    ws.onopen = () => { state.wsOpen = true; dot.classList.add('on'); dot.title = 'Live'; };
    ws.onmessage = (e) => { try { onFrame(JSON.parse(e.data)); } catch { /* ignore malformed frame */ } };
    ws.onclose = () => { state.wsOpen = false; dot.classList.remove('on'); dot.title = 'Reconnecting'; if (state.busy) setBusy(false); setTimeout(connect, 2500); };
  }

  await loadThreads();
  connect();
  const prefill = sessionStorage.getItem('pv_prefill');
  if (prefill) { sessionStorage.removeItem('pv_prefill'); state.current = null; feed.replaceChildren(welcome()); title.textContent = 'New conversation'; sub.textContent = 'Private to this session'; ta.value = prefill; ta.focus(); }
  else await open(state.threads.find((t) => t.id !== 'thr_inbox')?.id || 'thr_inbox');
  const ping = setInterval(() => { if (state.wsOpen) state.ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
  return () => { state.closed = true; clearInterval(ping); try { state.ws && state.ws.close(); } catch { /* ignore */ } };
}
