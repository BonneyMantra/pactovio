// Shared UI helpers for every screen: API client, element builder, formatting, icons, states, toasts.

export async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', headers: { accept: 'application/json' }, ...opts };
  if (opts.body && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }
  const bounded = /^\/(auth(?:\/|$)|session$|onboarding(?:\/|$))/.test(path);
  const res = await fetch(`/api${path}`, { ...init, signal: init.signal || (bounded ? AbortSignal.timeout(30000) : undefined) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.code = data && data.code;
    err.retryAfter = Number(res.headers.get('retry-after') || data?.retry_after || 0);
    if (res.status === 401 && path !== '/session' && !path.startsWith('/auth/')) window.dispatchEvent(new Event('pv:session-expired'));
    throw err;
  }
  return data;
}

/** h('div.card.stat', { onclick }, child, 'text') — tag with dot classes, props, children (strings, nodes, arrays, null). */
export function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export const icon = (name, size = 16) => {
  const span = document.createElement('span');
  span.className = 'ico';
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dot}</svg>`;
  return span;
};

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  tender: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>',
  quote: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="19" cy="17" r="2"/>',
  plug: '<path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5"/>',
  agent: '<path d="M12 3a3 3 0 0 1 3 3v1h2a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3h2V6a3 3 0 0 1 3-3z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  evidence: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  paper: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  out: '<path d="M7 17 17 7M7 7h10v10"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  dot: '<circle cx="12" cy="12" r="2"/>',
  logo: '<path d="M5 19V6.5A1.5 1.5 0 0 1 6.5 5H13a5 5 0 0 1 0 10H9" stroke-width="2.2"/><circle cx="17.5" cy="18.5" r="1.6" fill="currentColor" stroke="none"/>',
};

export const fmt = {
  money(minor, cur = 'USD') {
    if (minor == null) return '—';
    const v = Number(minor) / 100;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v); } catch { return `${cur} ${v.toFixed(2)}`; }
  },
  moneyMajor(v, cur = 'EUR') {
    if (v == null) return '—';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, notation: v >= 1e6 ? 'compact' : 'standard', maximumFractionDigits: v >= 1e6 ? 2 : 0 }).format(v); } catch { return `${cur} ${v}`; }
  },
  date(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); },
  dateTime(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); },
  ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
  },
  until(iso) {
    if (!iso) return '';
    const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
    if (days < 0) return 'closed'; if (days === 0) return 'closes today'; return `${days} day${days === 1 ? '' : 's'} left`;
  },
  usd(n) { return n == null ? '—' : `$${Number(n).toFixed(n < 1 ? 3 : 2)}`; },
  tokens(n) { if (n == null) return '—'; return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n); },
};

const TONE = {
  MET: 'ok', BID: 'ok', connected: 'ok', approved: 'ok', completed: 'ok', succeeded: 'ok', sent: 'ok', won: 'ok', accepted: 'ok',
  PARTIAL: 'warn', CONDITIONAL: 'warn', pending: 'warn', draft: 'warn', processing: 'info', running: 'info', queued: 'info', new: 'info', shortlisted: 'accent',
  GAP: 'bad', NO_BID: 'bad', failed: 'bad', error: 'bad', expired: 'bad', declined: 'bad', rejected: 'bad',
  NEEDS_EVIDENCE: '', available: '', dismissed: '',
};
const LABEL = { NEEDS_EVIDENCE: 'Needs evidence', NO_BID: 'No bid', CONDITIONAL: 'Bid with conditions', BID: 'Bid', needs_work_account: 'Needs M365 work account' };
export function chip(status, text) {
  const tone = TONE[status] ?? '';
  const label = text ?? LABEL[status] ?? String(status ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return h(`span.chip${tone ? '.' + tone : ''}`, h('span.dot'), label);
}

export const cite = (n, title) => h('span.cite', { title: title || '' }, String(n));

export function skeleton(lines = 4) {
  return h('div', { style: { display: 'grid', gap: '10px' } }, Array.from({ length: lines }, (_, i) => h('div.skeleton', { style: { height: i === 0 ? '28px' : '16px', width: `${90 - i * 12}%` } })));
}
export function empty(title, body, action) { return h('div.empty', h('div.h4', title), body ? h('div', body) : null, action ? h('div', { style: { marginTop: '14px' } }, action) : null); }
export function errorBox(err) { return h('div.error-box', err && err.message ? err.message : String(err)); }

/** Render async content into el with loading + error states. */
export async function load(el, fn, lines = 5) {
  el.replaceChildren(skeleton(lines));
  try { const node = await fn(); el.replaceChildren(node); } catch (e) { el.replaceChildren(errorBox(e)); }
}

export function toast(msg) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = h('div.toast-wrap'); document.body.appendChild(wrap); }
  const t = h('div.toast', msg);
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

export const PROVIDER = {
  gmail: { name: 'Gmail', color: '#EA4335', cat: 'Email' }, outlook: { name: 'Outlook', color: '#0A64AD', cat: 'Email' },
  slack: { name: 'Slack', color: '#4A154B', cat: 'Chat' }, microsoft_teams: { name: 'Microsoft Teams', color: '#5059C9', cat: 'Chat' },
  hubspot: { name: 'HubSpot', color: '#FF7A59', cat: 'CRM' }, salesforce: { name: 'Salesforce', color: '#00A1E0', cat: 'CRM' },
  googledrive: { name: 'Google Drive', color: '#1FA463', cat: 'Files' }, dropbox: { name: 'Dropbox', color: '#0061FE', cat: 'Files' },
  googlecalendar: { name: 'Google Calendar', color: '#4285F4', cat: 'Calendar' }, outlook_calendar: { name: 'Outlook Calendar', color: '#0A64AD', cat: 'Calendar' },
  jira: { name: 'Jira', color: '#2684FF', cat: 'Projects' }, asana: { name: 'Asana', color: '#F06A6A', cat: 'Projects' },
  docusign: { name: 'DocuSign', color: '#FFCC22', cat: 'Signing' }, quickbooks: { name: 'QuickBooks', color: '#2CA01C', cat: 'Accounting' }, xero: { name: 'Xero', color: '#13B5EA', cat: 'Accounting' },
};
export function providerMark(id, size = 20) {
  const p = PROVIDER[id] || { name: id, color: '#8d8b85' };
  return h('span', { title: p.name, style: { width: `${size}px`, height: `${size}px`, borderRadius: '6px', background: p.color, color: '#fff', display: 'inline-grid', placeItems: 'center', fontSize: `${Math.round(size * 0.5)}px`, fontWeight: 650, flex: 'none' } }, p.name[0]);
}
