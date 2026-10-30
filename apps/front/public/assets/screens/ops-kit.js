// Shared pieces for the ops screens (quotes, agent, connections, billing).
import { h, fmt } from '../ui.js';

const SI = 'https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/';
// Brand tiles: official Simple Icons glyph in white on the brand colour. Providers missing from
// Simple Icons (Microsoft apps, DocuSign) get a neutral tile with initials.
export const BRAND = {
  gmail: { slug: 'gmail', color: '#EA4335' }, slack: { slug: 'slack', color: '#4A154B' }, hubspot: { slug: 'hubspot', color: '#FF7A59' },
  salesforce: { slug: 'salesforce', color: '#00A1E0' }, googledrive: { slug: 'googledrive', color: '#1FA463' }, dropbox: { slug: 'dropbox', color: '#0061FE' },
  googlecalendar: { slug: 'googlecalendar', color: '#4285F4' }, jira: { slug: 'jira', color: '#0052CC' }, asana: { slug: 'asana', color: '#F06A6A' },
  quickbooks: { slug: 'quickbooks', color: '#2CA01C' }, xero: { slug: 'xero', color: '#13B5EA' },
  outlook: { initials: 'Ol' }, outlook_calendar: { initials: 'OC' }, microsoft_teams: { initials: 'Tm' }, docusign: { initials: 'DS' },
};

export function logoTile(provider, size = 36, name = '') {
  const b = BRAND[provider] || { initials: (name || provider || '?').slice(0, 2) };
  const tile = h('span.logo-tile', { title: name || provider, style: { width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.28)}px` } });
  if (b.slug) {
    tile.style.background = b.color;
    const g = h('span.logo-glyph');
    const url = `url(${SI}${b.slug}.svg)`;
    Object.assign(g.style, { width: `${Math.round(size * 0.52)}px`, height: `${Math.round(size * 0.52)}px`, WebkitMaskImage: url, maskImage: url });
    tile.appendChild(g);
  } else {
    tile.classList.add('neutral');
    tile.style.fontSize = `${Math.round(size * 0.36)}px`;
    tile.textContent = b.initials;
  }
  return tile;
}

/** Small stacked brand marks ("4 sources used"). */
export function sourceMarks(providers) {
  return h('span.src-marks', providers.map((p) => logoTile(p, 16)));
}

export function meter(label, used, cap, hint) {
  const pct = cap ? Math.min(100, Math.round((Number(used) / Number(cap)) * 100)) : 0;
  return h('div.meter',
    h('div.meter-top', h('span', label), h('span.num.muted', cap ? `${used ?? 0} / ${cap}` : String(used ?? '—'))),
    h('div.meter-bar', h('span', { style: { width: `${pct}%` } })),
    hint ? h('div.xs.muted', { style: { marginTop: '6px' } }, hint) : null);
}

export const opt = (v, fallback = '—') => (v == null || v === '' ? fallback : v);

export function money(minor, cur) { return minor == null ? '—' : fmt.money(minor, cur || 'USD'); }

/** Prompt-free confirm: a tiny inline popover row that resolves true/false. */
export function confirmRow(anchor, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const row = h('div.action-req.fade-in', { style: { marginTop: '10px' } },
      h('div.label', text),
      h('button.btn.btn-secondary.btn-xs', { onclick: () => { row.remove(); resolve(false); } }, 'Cancel'),
      h('button.btn.btn-primary.btn-xs', { onclick: () => { row.remove(); resolve(true); } }, okLabel));
    anchor.after(row);
  });
}

export function sectionHead(title, right) {
  return h('div.section-title', h('h3', title), right || null);
}

export function backLink(href, label) {
  return h('a.back-link', { href }, '← ', label);
}
