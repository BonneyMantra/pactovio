// Tender tabs: the compliance matrix (every requirement with its source page) and the drafted answers.
import { api, h, icon, chip, toast, empty } from '../ui.js';
import { dash, docName, tabs } from './work-kit.js';

const STATUSES = ['MET', 'PARTIAL', 'GAP', 'NEEDS_EVIDENCE'];
const PAGE = 80;

export function matrixTab({ reqs, docs }) {
  if (!reqs.length) return empty('No requirements yet', 'A pack read extracts every requirement with its document and page.');
  let status = 'all', lot = 'all', q = '', limit = PAGE;
  const lots = [...new Set(reqs.map((r) => r.lot).filter(Boolean))];
  const search = h('input.input.wk-search', { placeholder: 'Search requirements', type: 'search' });
  const lotSeg = () => (lots.length > 1 ? tabs([{ id: 'all', label: 'All lots' }, ...lots.map((l) => ({ id: l, label: `Lot ${l}` }))], lot, (v) => { lot = v; limit = PAGE; draw(); }) : null);
  const bar = h('div.wk-mbar');
  const body = h('div');
  const el = h('div', bar, body);
  const count = (s) => reqs.filter((r) => (lot === 'all' || r.lot === lot || !r.lot) && (s === 'all' || (r.status || 'NEEDS_EVIDENCE') === s)).length;
  const row = (r) => {
    const fname = docName(docs, r.doc_id);
    const text = h('div.small.wk-req.wk-clamp3', r.text || dash);
    return h('tr', { onclick: () => text.classList.toggle('wk-clamp3') },
      h('td.mono.wk-ref', r.ref || dash),
      h('td', text, r.note ? h('div.xs.muted.wk-clamp2', { style: { marginTop: '4px' } }, r.note) : null),
      h('td.xs.muted', r.kind || dash, r.lot ? h('div', `Lot ${r.lot}`) : null),
      h('td', fname || r.page != null ? h('span.cite', { title: fname || 'Document' }, r.page != null ? `p.${r.page}` : 'doc') : h('span.muted', dash), fname ? h('div.xs.muted.wk-ellipsis.wk-docname', fname) : null),
      h('td', chip(r.status || 'NEEDS_EVIDENCE')));
  };
  const draw = () => {
    bar.replaceChildren(tabs([{ id: 'all', label: 'All', count: count('all') }, ...STATUSES.map((s) => ({ id: s, label: { MET: 'Met', PARTIAL: 'Partial', GAP: 'Gap', NEEDS_EVIDENCE: 'Needs evidence' }[s], count: count(s) }))], status, (s) => { status = s; limit = PAGE; draw(); }), h('div.wk-grow'), lotSeg(), search);
    const needle = q.trim().toLowerCase();
    const shown = reqs.filter((r) => (status === 'all' || (r.status || 'NEEDS_EVIDENCE') === status) && (lot === 'all' || r.lot === lot || !r.lot)
      && (!needle || `${r.ref} ${r.text} ${r.note}`.toLowerCase().includes(needle)));
    body.replaceChildren(shown.length
      ? h('div.card', h('div.wk-scroll', h('table.table.wk-matrix', h('thead', h('tr', h('th', 'Ref'), h('th', 'Requirement'), h('th', 'Kind'), h('th', 'Source'), h('th', 'Status'))), h('tbody', shown.slice(0, limit).map(row)))),
        shown.length > limit ? h('div.wk-more', h('button.btn.btn-secondary.btn-sm', { onclick: () => { limit += PAGE * 2; draw(); } }, `Show more (${shown.length - limit} left)`)) : null)
      : h('div.card', empty('No requirements match', 'Try another status or clear the search.')));
  };
  search.addEventListener('input', () => { q = search.value; limit = PAGE; draw(); search.focus(); });
  draw();
  return el;
}

/** Highlight "[NEEDS_EVIDENCE: …]" markers the claim check left in a draft. */
function draftText(s) {
  if (!s) return [h('span.muted', 'No draft yet.')];
  const out = [];
  const re = /\[(NEEDS_EVIDENCE[^\]]*)\]/g;
  let last = 0, m;
  while ((m = re.exec(s))) { out.push(s.slice(last, m.index)); out.push(h('mark.wk-flag', { title: 'Removed by the claim check: no evidence on file' }, m[1].replace(/^NEEDS_EVIDENCE:?\s*/, 'Needs evidence: '))); last = m.index + m[0].length; }
  out.push(s.slice(last));
  return out;
}

/** NeMo Guardrails audit for one answer: the Nebius job's result, or its queued state. */
function guardPanel(au) {
  if (!au) return h('div.wk-guard', icon('shield', 14), h('span.xs', h('b', 'NeMo Guardrails')), h('span.xs.muted', 'Queued for audit in a Nebius job'));
  const done = au.status === 'completed';
  const s = (au.result && au.result.summary) || {};
  const judge = au.result && au.result.engine && au.result.engine.judge_model;
  return h('div.wk-guard', icon('shield', 14), h('span.xs', h('b', 'NeMo Guardrails')),
    chip(done ? 'completed' : au.status, done ? 'Audited' : au.status === 'queued' ? 'Queued' : String(au.status)),
    done ? h('span.xs.muted', `${s.claims_flagged ?? 0} flagged · ${s.claims_unsupported ?? 0} unsupported`) : h('span.xs.muted', 'Runs as a Nebius job'),
    judge ? h('span.xs.muted', `judge ${String(judge).split('/').pop()}`) : null);
}

async function auditMap() {
  const m = new Map();
  try {
    const ids = ((await api('/limits')).audits || []).filter((a) => a.subject_type === 'answer').slice(0, 20).map((a) => a.id);
    const rows = await Promise.all(ids.map((id) => api(`/audits/${encodeURIComponent(id)}`).catch(() => null)));
    rows.filter(Boolean).forEach((a) => m.set(a.subject_id, a));
  } catch { /* audits are decoration */ }
  return m;
}

function answerCard(a, tenderId, onChange, audit) {
  const claims = Array.isArray(a.claims) ? a.claims : [];
  const unsupported = claims.filter((c) => c && c.supported === false).length;
  const setStatus = async (status, btn) => {
    btn.disabled = true;
    try { const upd = await api(`/tenders/${encodeURIComponent(tenderId)}/answers/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { status } }); toast(status === 'approved' ? 'Answer approved' : 'Moved back to draft'); onChange(upd || { ...a, status }); } catch (e) { toast(e.message); btn.disabled = false; }
  };
  const approve = h('button.btn.btn-primary.btn-xs', { onclick: (e) => setStatus('approved', e.currentTarget) }, icon('check', 14), 'Approve');
  const back = h('button.btn.btn-secondary.btn-xs', { onclick: (e) => setStatus('draft', e.currentTarget) }, 'Back to draft');
  return h('div.card.wk-answer',
    h('div.wk-answer-top', h('span.mono.wk-ref', a.question_ref || dash), a.lot ? h('span.xs.muted', `Lot ${a.lot}`) : null, h('span.wk-grow'), chip(a.status || 'draft')),
    h('div.small.muted.wk-q', a.question || dash),
    h('div.wk-draft', draftText(a.draft)),
    claims.length ? h('div.wk-claims', h('span.xs.muted', `${claims.length} claim${claims.length === 1 ? '' : 's'} checked`), unsupported ? h('span.chip.bad', `${unsupported} unsupported, removed`) : h('span.chip.ok', 'All supported')) : null,
    guardPanel(audit),
    h('div.wk-answer-foot', a.word_limit ? h('span.xs.muted', `Limit ${a.word_limit} words`) : h('span'), a.status === 'approved' ? back : approve));
}

export async function answersTab({ tenderId }) {
  const [res, audits] = await Promise.all([api(`/tenders/${encodeURIComponent(tenderId)}/answers`), auditMap()]);
  const items = res.items || [];
  if (!items.length) return empty('No drafted answers yet', 'After a pack read, Pactovio drafts the scored questions from your evidence and strikes any claim it cannot back.');
  const list = h('div.wk-answers');
  const byId = new Map(items.map((a) => [a.id, a]));
  const draw = () => list.replaceChildren(...[...byId.values()].map((a) => answerCard(a, tenderId, (upd) => { byId.set(a.id, { ...a, ...upd }); draw(); }, audits.get(a.id))));
  draw();
  const approved = items.filter((a) => a.status === 'approved').length;
  return h('div', h('div.wk-note.small', icon('shield', 14), `Every sentence is claim-checked against your evidence before you see it. ${approved} of ${items.length} approved.`), list);
}
