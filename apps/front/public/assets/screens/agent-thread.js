// Rendering for agent messages: markdown-light text with citation chips, collapsible tool runs,
// and action cards that ask before the agent changes anything.
import { h, icon, fmt, cite } from '../ui.js';
import { logoTile } from './ops-kit.js';

const TOOL_LABEL = {
  list_today: "Read today's list", search_tenders: 'Searched tenders', get_tender: 'Opened the tender', start_pack_run: 'Pack read',
  get_matrix: 'Read the compliance matrix', get_verdicts: 'Read the verdicts', draft_answers: 'Drafted answers', approve_answer: 'Approved an answer',
  buyer_intel: 'Looked up the buyer', list_intakes: 'Read the inbox', create_design_request_from_text: 'Created a design request',
  match_design_request: 'Matched against datasheets', create_quote: 'Drafted a quote', list_connectors: 'Checked connections',
  run_connector_action: 'Connector action', billing_status: 'Checked billing', get_limits: 'Checked limits',
};

function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|\[(\d{1,2})\]|`[^`]+`)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[2]) frag.append(cite(m[2]));
    else if (m[0].startsWith('**')) frag.append(h('strong', m[0].slice(2, -2)));
    else frag.append(h('code', m[0].slice(1, -1)));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** Paragraphs and simple bullet lists from plain model text. */
export function richText(text = '') {
  const wrap = h('div.msg-text');
  const blocks = String(text).trim().split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      wrap.append(h('ul', lines.map((l) => h('li', inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))))));
    } else {
      wrap.append(h('p', lines.flatMap((l, i) => (i ? [h('br'), inline(l)] : [inline(l)]))));
    }
  }
  return wrap;
}

/** "Completed 3 actions ›" with the tool list on expand. */
export function toolGroup(calls) {
  const list = h('div.tool-list');
  const head = h('button.tool-head', { onclick: () => group.classList.toggle('open') }, h('span.tool-label'), icon('chev', 14));
  const group = h('div.tool-group', head, list);
  const providers = new Set();
  const update = () => {
    const running = calls.some((c) => c.status === 'running');
    head.querySelector('.tool-label').textContent = running ? `Working… ${calls.length} action${calls.length === 1 ? '' : 's'}` : `Completed ${calls.length} action${calls.length === 1 ? '' : 's'}`;
    group.classList.toggle('running', running);
    list.replaceChildren(...calls.map((c) => h('div.tool-row',
      h(`span.tool-dot.${c.status || 'ok'}`), h('span', TOOL_LABEL[c.name] || c.name),
      c.input?.provider ? h('span.muted.xs', ` · ${c.input.provider}`) : null,
      h('span.spacer'), h('span.xs.muted', c.status === 'pending_confirmation' ? 'waiting for you' : c.status || 'ok'))));
    calls.forEach((c) => c.input?.provider && providers.add(c.input.provider));
  };
  update();
  return { el: group, add(call) { const i = calls.findIndex((c) => c.call_id && c.call_id === call.call_id); if (i >= 0) calls[i] = { ...calls[i], ...call }; else calls.push(call); update(); }, providers };
}

export function messageEl(msg) {
  if (msg.role === 'user') return h('div.msg.user', h('div.bubble', richText(msg.content)));
  const body = h('div.msg-body');
  if (msg.tool_calls?.length) body.append(toolGroup(msg.tool_calls.map((t) => ({ ...t, status: 'ok' }))).el);
  if (msg.content) body.append(richText(msg.content));
  const provs = (msg.tool_calls || []).map((t) => t.input?.provider).filter(Boolean);
  if (provs.length) body.append(h('div.src-line', `${provs.length} source${provs.length === 1 ? '' : 's'} used`, h('span.src-marks', provs.map((p) => logoTile(p, 16)))));
  return h('div.msg.assistant', h('span.agent-av', icon('logo', 14)), h('div.msg-col', h('div.msg-who', 'Pactovio', h('span.xs.muted', fmt.ago(msg.at))), body));
}

/** Action card. `decide(id, decision)` must resolve to the updated PendingAction. */
export function actionCard(action, decide) {
  const detail = h('div.action-detail', action.detail || action.summary || '', action.input && Object.keys(action.input).length
    ? h('pre.action-input', JSON.stringify(action.input, null, 2).slice(0, 800)) : null);
  const status = h('span.xs.muted');
  const btns = h('div.action-btns');
  const card = h('div.action-wrap',
    h('div.action-req',
      h('div.label', icon(action.tool === 'run_connector_action' ? 'paper' : 'bolt'), h('span.clamp', action.title || action.summary || action.tool)),
      btns),
    detail, status);
  const setState = (a) => {
    btns.replaceChildren();
    if (a.status === 'pending') {
      btns.append(
        h('button.btn.btn-ghost.btn-xs', { onclick: () => card.classList.toggle('open') }, 'See details'),
        h('button.btn.btn-secondary.btn-xs', { onclick: () => go('decline') }, 'Reject'),
        h('button.btn.btn-primary.btn-xs', { onclick: () => go('confirm') }, 'Confirm'));
      status.textContent = '';
    } else {
      const label = { executed: 'Done', confirmed: 'Confirmed', declined: 'Declined', failed: 'Failed' }[a.status] || a.status;
      btns.append(h(`span.chip.${a.status === 'executed' || a.status === 'confirmed' ? 'ok' : a.status === 'failed' ? 'bad' : ''}`, h('span.dot'), label));
      if (a.status === 'failed' && a.result) status.textContent = typeof a.result === 'string' ? a.result : (a.result.error || '');
    }
  };
  const go = async (decision) => {
    btns.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { const a = await decide(action.id, decision); if (a) setState(a); } catch (e) { status.textContent = e.message; setState(action); }
  };
  setState(action);
  card.update = setState;
  return card;
}
