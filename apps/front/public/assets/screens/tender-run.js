// Tender tabs: fill the buyer's own forms, inspect the pack-run steps (model, tokens, cost), buyer intel.
import { api, h, icon, fmt, chip, toast, empty, errorBox } from '../ui.js';
import { dash } from './work-kit.js';

export async function formsTab({ tenderId, docs }) {
  if (!docs.length) return empty('No documents in this pack');
  const forms = docs.filter((d) => d.is_form);
  const other = docs.filter((d) => !d.is_form);
  const formRow = (d) => {
    const isDocx = /\.docx$/i.test(d.filename || '');
    const status = h('span.xs.muted', isDocx ? 'Buyer form' : 'Spreadsheet: fill by hand');
    const dl = h('a.btn.btn-secondary.btn-xs', { href: `/api/tenders/${encodeURIComponent(tenderId)}/forms/${encodeURIComponent(d.id)}/filled`, hidden: true, download: '' }, icon('download', 14), 'Download');
    const fill = h('button.btn.btn-primary.btn-xs', {
      disabled: !isDocx,
      onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true; b.lastChild.textContent = 'Filling…';
        try { await api(`/tenders/${encodeURIComponent(tenderId)}/forms/${encodeURIComponent(d.id)}/fill`, { method: 'POST', body: {} }); status.textContent = 'Filled with approved answers'; dl.hidden = false; toast('Form filled in the buyer’s own DOCX'); }
        catch (err) { toast(err.status === 409 || /approved/i.test(err.message) ? 'Approve at least one answer first' : err.message); }
        b.disabled = false; b.lastChild.textContent = 'Fill';
      },
    }, icon('bolt', 14), 'Fill');
    return h('div.wk-doc', icon('file'), h('div', { style: { minWidth: 0, flex: 1 } }, h('div.small.wk-ellipsis', d.filename || d.id), status), dl, fill);
  };
  return h('div.wk-two',
    h('div', h('div.section-title', h('h3', 'Forms to return')), h('div.card.wk-list', forms.length ? forms.map(formRow) : empty('No fillable forms detected'))),
    h('div', h('div.section-title', h('h3', 'Pack documents')), h('div.card.wk-list', other.length ? other.map((d) => h('div.wk-doc', icon('file'), h('div', { style: { minWidth: 0, flex: 1 } }, h('div.small.wk-ellipsis', d.filename || d.id), h('div.xs.muted', d.pages ? `${d.pages} pages` : (d.kind || '').toUpperCase())))) : empty('No other documents'))),
    h('div.wk-note.small', { style: { gridColumn: '1 / -1' } }, icon('shield', 14), 'Answers are written into the buyer’s own Word form; every other part of the file stays byte-identical.'));
}

const MODEL = (m) => (m ? m.replace(/^.*\//, '') : 'Code');

function stepRow(s) {
  return h('tr', h('td.mono.muted', String(s.seq ?? '')), h('td', h('div.small', s.purpose || dash), s.summary ? h('div.xs.muted.wk-clamp2', s.summary) : null),
    h('td.xs', MODEL(s.model)), h('td.r.num.small', s.tokens_in ? fmt.tokens(s.tokens_in) : dash), h('td.r.num.small.muted', s.tokens_cached ? fmt.tokens(s.tokens_cached) : dash),
    h('td.r.num.small', s.tokens_out ? fmt.tokens(s.tokens_out) : dash), h('td.r.num.small.muted', s.ms != null ? `${(s.ms / 1000).toFixed(1)}s` : dash), h('td.r.num.small', s.cost_usd ? fmt.usd(s.cost_usd) : dash), h('td', s.status && s.status !== 'ok' ? chip(s.status) : null));
}

export async function runTab({ runId }) {
  if (!runId) return empty('No run yet', 'Start a Replay (free) or a Fresh read to see every model call, its tokens and its cost.');
  const d = await api(`/runs/${encodeURIComponent(runId)}`);
  const run = d.run || {};
  const steps = d.steps || [];
  const sum = (k) => steps.reduce((a, s) => a + (Number(s[k]) || 0), 0);
  const secs = run.started_at && run.finished_at ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) : null;
  const byModel = {};
  for (const s of steps) { const k = MODEL(s.model); byModel[k] = byModel[k] || { n: 0, cost: 0, tin: 0 }; byModel[k].n++; byModel[k].cost += Number(s.cost_usd) || 0; byModel[k].tin += Number(s.tokens_in) || 0; }
  const tbody = h('tbody', steps.map(stepRow));
  const statusEl = h('span', chip(run.status || 'queued'));
  const stats = h('div.grid.g4',
    h('div.card.stat', h('div.k', 'Status'), h('div', { style: { marginTop: '8px' } }, statusEl, run.replay ? h('span.chip.outline', { style: { marginLeft: '6px' } }, 'replay') : null)),
    h('div.card.stat', h('div.k', 'Duration'), h('div.v', secs != null ? `${Math.floor(secs / 60)}m ${secs % 60}s` : dash)),
    h('div.card.stat', h('div.k', 'Tokens in / cached / out'), h('div.v', { style: { fontSize: '20px' } }, `${fmt.tokens(run.tokens_in ?? sum('tokens_in'))} · ${fmt.tokens(sum('tokens_cached'))} · ${fmt.tokens(run.tokens_out ?? sum('tokens_out'))}`)),
    h('div.card.stat', h('div.k', 'Model cost'), h('div.v', run.cost_usd != null ? fmt.usd(run.cost_usd) : steps.length ? fmt.usd(sum('cost_usd')) : dash)));
  const models = Object.keys(byModel).length ? h('div.wk-models', Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => h('div.wk-model', h('div.small', { style: { fontWeight: 510 } }, k), h('div.xs.muted', `${v.n} step${v.n === 1 ? '' : 's'} · ${fmt.tokens(v.tin)} in · ${fmt.usd(v.cost)}`)))) : null;
  const el = h('div', stats, models,
    h('div.card', { style: { marginTop: '16px' } }, steps.length || run.status === 'running' || run.status === 'queued'
      ? h('div.wk-scroll', h('table.table.wk-steps', h('thead', h('tr', h('th', '#'), h('th', 'Step'), h('th', 'Model'), h('th.r', 'In'), h('th.r', 'Cached'), h('th.r', 'Out'), h('th.r', 'Time'), h('th.r', 'Cost'), h('th', ''))), tbody))
      : empty('This run has no recorded steps')));
  let es = null;
  if (run.status === 'running' || run.status === 'queued') {
    es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    const seen = new Set(steps.map((s) => s.seq));
    es.addEventListener('step', (ev) => { try { const s = JSON.parse(ev.data); if (!seen.has(s.seq)) { seen.add(s.seq); tbody.appendChild(stepRow(s)); } } catch { /* skip */ } });
    es.addEventListener('done', (ev) => { try { const r = JSON.parse(ev.data); statusEl.replaceChildren(chip(r.status || 'completed')); toast('Run finished. Reload to see the new verdict.'); } catch { /* skip */ } es.close(); });
    es.onerror = () => { /* the browser reconnects on its own */ };
  }
  return { el, cleanup: () => es && es.close() };
}

export async function buyerTab({ buyerKey, tender }) {
  if (!buyerKey) return empty('No buyer on this tender');
  const wrap = h('div');
  const draw = (b) => {
    const sources = b.sources || [];
    wrap.replaceChildren(h('div.wk-two',
      h('div.card.wk-pad', h('div.xs.muted', `Buyer intel · ${tender.buyer || buyerKey}`), h('p.small', { style: { margin: '8px 0 14px' } }, b.summary || dash),
        (b.facts || []).map((f) => h('div.wk-kv', h('span.xs.muted', f.label || dash), h('span.small', f.value || dash, f.source_idx != null && sources[f.source_idx] ? h('span.cite', { title: sources[f.source_idx].title || '' }, String(f.source_idx + 1)) : null)))),
      h('div.card.wk-pad', h('div.xs.muted', 'Sources'), sources.length ? h('ol.wk-sources', sources.map((s) => h('li.small', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title || s.url), s.snippet ? h('div.xs.muted.wk-clamp2', s.snippet) : null))) : h('div.small.muted', dash),
        h('div.xs.muted', { style: { marginTop: '12px' } }, b.fetched_at ? `Fetched ${fmt.ago(b.fetched_at)} with Tavily` : ''))));
  };
  const refreshBtn = () => h('button.btn.btn-primary.btn-sm', {
    onclick: async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.lastChild.textContent = 'Searching…';
      try { await api(`/buyers/${encodeURIComponent(buyerKey)}/refresh`, { method: 'POST' }); draw(await api(`/buyers/${encodeURIComponent(buyerKey)}`)); }
      catch (err) { toast(err.status === 429 ? 'Live searches are capped per session. Try again later.' : err.message); btn.disabled = false; btn.lastChild.textContent = 'Research this buyer'; }
    },
  }, icon('search', 14), 'Research this buyer');
  try { draw(await api(`/buyers/${encodeURIComponent(buyerKey)}`)); }
  catch (e) {
    if (e.status === 404) wrap.replaceChildren(h('div.card', empty('No intel on this buyer yet', 'One live web search (official sources first) builds a cited profile: budget, past awards, who decides.', refreshBtn())));
    else wrap.replaceChildren(errorBox(e));
  }
  return wrap;
}
