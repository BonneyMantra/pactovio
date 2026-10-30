// Shared pieces for the work screens (Today, Inbox, Tenders, Evidence). Every optional field is guarded.
import { h, icon, chip, PROVIDER, providerMark } from '../ui.js';

export const dash = '—';
export const val = (v) => (v == null || v === '' ? dash : v);

const DOOR = { rfq: 'RFQ', rfp: 'RFP', design: 'Design request', tender: 'Tender', other: 'Other' };
const DOOR_TONE = { rfq: 'accent', rfp: 'info', design: 'accent', tender: 'info', other: '' };

/** The intake's effective door: the classifier's call when present, else the stored door. */
export function doorOf(intake) {
  if (!intake) return 'other';
  if (intake.status === 'ignored') return 'ignored';
  return intake.classification?.door || intake.door || 'other';
}

export function doorChip(intake) {
  const d = doorOf(intake);
  if (d === 'ignored') return h('span.chip', h('span.dot'), 'Ignored');
  return h(`span.chip${DOOR_TONE[d] ? '.' + DOOR_TONE[d] : ''}`, h('span.dot'), DOOR[d] || d);
}

const SOURCE = { gmail: 'gmail', outlook: 'outlook', slack: 'slack', microsoft_teams: 'microsoft_teams' };
export function sourceMark(src, size = 28) {
  if (SOURCE[src] && PROVIDER[src]) return providerMark(src, size);
  const glyph = { scan: 'globe', upload: 'file', api: 'bolt', manual: 'file' }[src] || 'inbox';
  return h('span.wk-src', { style: { width: `${size}px`, height: `${size}px` }, title: src || 'source' }, icon(glyph, Math.round(size * 0.5)));
}

export function senderName(s) {
  if (!s) return dash;
  const m = String(s).match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : s).trim();
}

/** Small fit-score ring (0..100). */
export function fitRing(score, size = 40) {
  const s = Number.isFinite(Number(score)) ? Math.max(0, Math.min(100, Number(score))) : null;
  const r = (size - 5) / 2, c = 2 * Math.PI * r, off = s == null ? c : c * (1 - s / 100);
  const tone = s == null ? 'var(--ink-4)' : s >= 70 ? 'var(--ok)' : s >= 45 ? 'var(--warn)' : 'var(--bad)';
  const wrap = h('span.wk-ring', { style: { width: `${size}px`, height: `${size}px` }, title: s == null ? 'No fit score' : `Fit ${s}/100` });
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line-soft)" stroke-width="3"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${tone}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  wrap.appendChild(h('span.wk-ring-n.num', s == null ? dash : String(s)));
  return wrap;
}

export const DECISION = { BID: 'Bid', CONDITIONAL: 'Bid with conditions', NO_BID: 'No bid' };

/** Turn "… (File name.pdf p.17) …" into text with a citation chip; returns node array. */
export function withCites(text) {
  if (!text) return [dash];
  const out = [];
  const re = /\(([^()]*?(?:\.(?:pdf|docx?|xlsx?|csv|txt)|\bp\.\s*\d+|\bpages?\s+\d+)[^()]*?)\)/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out.push(text.slice(last, m.index).replace(/\s+$/, ' '));
    const inner = m[1];
    const page = inner.match(/\b(?:p\.|pages?)\s*(\d+(?:\s*[–-]\s*\d+)?)/i);
    out.push(h('span.cite', { title: inner }, page ? `p.${page[1].replace(/\s+/g, '')}` : 'doc'));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export function docName(docs, id) {
  const d = (docs || []).find((x) => x.id === id);
  return d ? d.filename : null;
}

export function statusChip(s) { return chip(s || 'NEEDS_EVIDENCE'); }

export function tabs(items, active, onPick) {
  return h('div.wk-tabs', { role: 'tablist' }, items.map((it) => h(`button.wk-tab${it.id === active ? '.on' : ''}`, {
    role: 'tab', 'aria-selected': it.id === active ? 'true' : 'false', onclick: () => onPick(it.id),
  }, it.label, it.count != null ? h('span.wk-tab-n.num', String(it.count)) : null)));
}

export function sectionTitle(title, right) { return h('div.section-title', h('h3', title), right || null); }
