// Tender detail, the hero screen: header, verdict per lot with gates and cited reasons, then tabs.
import { api, h, icon, fmt, chip, toast, errorBox, skeleton } from '../ui.js';
import { dash, fitRing, DECISION, withCites, tabs } from './work-kit.js';
import { matrixTab, answersTab } from './tender-tabs.js';
import { formsTab, runTab, buyerTab } from './tender-run.js';

const TONE = { BID: 'ok', CONDITIONAL: 'warn', NO_BID: 'bad' };

function uniqueGates(gates) {
  const seen = new Set();
  return (gates || []).filter((g) => { const k = `${g?.name}|${g?.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function verdictCard(v, lotTitle) {
  const tone = TONE[v.decision] || '';
  const gates = uniqueGates(v.gates);
  const failed = gates.filter((g) => g && g.passed === false);
  const score = Number.isFinite(Number(v.score)) ? Number(v.score) : null;
  const gatesBox = h('div.wk-gates', { hidden: true }, gates.map((g) => h('div.wk-gate', h('span', { class: `wk-gate-ico ${g.passed ? 'ok' : 'bad'}` }, icon(g.passed ? 'check' : 'x', 12)),
    h('div', { style: { minWidth: 0 } }, h('div.small', { style: { fontWeight: 510 } }, g.name || 'Gate'), g.detail ? h('div.xs.muted', g.detail) : null))));
  const more = h('button.btn.btn-ghost.btn-xs', { onclick: () => { gatesBox.hidden = !gatesBox.hidden; more.lastChild.textContent = gatesBox.hidden ? `Show all ${gates.length} gates` : 'Hide gates'; } }, icon('down', 14), `Show all ${gates.length} gates`);
  return h(`div.card.wk-verdict.${tone || 'none'}`,
    h('div.wk-verdict-top',
      h('div', h('div.xs.muted', `Lot ${v.lot || '1'}${lotTitle ? ` · ${lotTitle}` : ''}`), h('div', { class: `wk-decision ${tone}` }, DECISION[v.decision] || v.decision || dash)),
      h('div.wk-score', h('span.num', score == null ? dash : String(score)), h('span.xs.muted', '/100'))),
    score != null ? h('div.wk-bar', h('span', { class: tone, style: { width: `${score}%` } })) : null,
    (v.reasons || []).length ? h('ol.wk-reasons', v.reasons.slice(0, 5).map((r) => h('li.small', withCites(r)))) : h('div.small.muted', 'No reasons recorded for this lot.'),
    gates.length ? h('div.wk-gate-sum', failed.length ? h('span.chip.bad', `${failed.length} gate${failed.length === 1 ? '' : 's'} failed`) : h('span.chip.ok', 'All gates passed'), h('span.xs.muted', `${gates.length - failed.length} of ${gates.length} passed`), h('span.wk-grow'), more) : null,
    gatesBox);
}

async function startRun(tenderId, replay, onStarted) {
  try {
    const r = await api(`/tenders/${encodeURIComponent(tenderId)}/runs`, { method: 'POST', body: replay ? { replay: true } : {} });
    toast(replay ? 'Replaying the recorded run' : 'Pack read started on Nemotron Ultra');
    onStarted(r.run_id);
  } catch (e) {
    toast(e.status === 429 ? 'Another fresh read is running on the shared model quota. Try the replay, or again in a few minutes.' : e.status === 402 ? 'Out of credits for fresh reads. The replay is free.' : e.message);
  }
}

export async function render(root, { id, rest }, ctx) {
  ctx.setCrumbs(h('a', { href: '#/tenders' }, 'Tenders'), 'Tender');
  root.append(skeleton(8));
  let d, matrix;
  try { [d, matrix] = await Promise.all([api(`/tenders/${encodeURIComponent(id)}`), api(`/tenders/${encodeURIComponent(id)}/matrix`).catch(() => null)]); } catch (e) { root.replaceChildren(errorBox(e)); return; }
  const t = d.tender || {};
  const m = d.match || null;
  const counts = d.requirement_counts || {};
  const verdicts = (d.verdicts && d.verdicts.length ? d.verdicts : matrix?.verdicts) || [];
  const reqs = matrix?.requirements || [];
  const lots = Array.isArray(t.lots) ? t.lots : [];
  let runId = d.latest_run?.id || null;
  ctx.setCrumbs(h('a', { href: '#/tenders' }, 'Tenders'), t.title || 'Tender');

  const TABS = [
    { id: 'matrix', label: 'Compliance matrix', count: counts.total ?? reqs.length },
    { id: 'answers', label: 'Answers' },
    { id: 'forms', label: 'Forms', count: (d.documents || []).filter((x) => x.is_form).length || null },
    { id: 'run', label: 'Run' },
    { id: 'buyer', label: 'Buyer' },
  ];
  let active = TABS.some((x) => x.id === rest?.[0]) ? rest[0] : 'matrix';
  const tabBar = h('div');
  const pane = h('div.wk-pane');
  let paneCleanup = null;
  const showTab = async (tab) => {
    active = tab;
    if (paneCleanup) { try { paneCleanup(); } catch { /* ignore */ } paneCleanup = null; }
    tabBar.replaceChildren(tabs(TABS, active, showTab));
    pane.replaceChildren(skeleton(5));
    try {
      const c = { tender: t, tenderId: id, docs: d.documents || [], reqs, counts, verdicts, runId, buyerKey: t.buyer_key };
      const node = tab === 'matrix' ? matrixTab(c) : tab === 'answers' ? await answersTab(c) : tab === 'forms' ? await formsTab(c) : tab === 'run' ? await runTab(c) : await buyerTab(c);
      if (node && node.cleanup) paneCleanup = node.cleanup;
      pane.replaceChildren(node?.el || node);
    } catch (e) { pane.replaceChildren(errorBox(e)); }
  };

  const onStarted = (rid) => { runId = rid; showTab('run'); };
  const meta = [t.buyer, t.country, t.value_eur ? fmt.moneyMajor(t.value_eur, 'EUR') : null, t.source ? `via ${t.source}` : null].filter(Boolean);
  const head = h('div.wk-thead',
    fitRing(m?.fit_score, 52),
    h('div', { style: { minWidth: 0, flex: 1 } },
      h('h1.title.wk-break', t.title || 'Untitled tender'),
      h('div.small.muted', meta.length ? meta.join(' · ') : dash),
      m?.fit_reason ? h('div.small.ink2.wk-clamp2', { style: { marginTop: '6px', maxWidth: '760px' } }, m.fit_reason) : null),
    h('div.wk-thead-side',
      t.deadline ? h('div.wk-deadline', h('div.xs.muted', 'Deadline'), h('div.small.num', fmt.dateTime(t.deadline)), h('div', { class: `xs ${fmt.until(t.deadline) === 'closed' ? 'muted' : ''}`, style: { color: 'var(--accent)' } }, fmt.until(t.deadline))) : h('div.xs.muted', 'No deadline listed'),
      h('div.wk-actions',
        t.url ? h('a.btn.btn-secondary.btn-sm', { href: t.url, target: '_blank', rel: 'noopener' }, 'Source', icon('out', 14)) : null,
        h('button.btn.btn-secondary.btn-sm', { onclick: () => startRun(id, true, onStarted), title: 'Free: plays back the recorded showcase run' }, icon('refresh', 14), 'Replay'),
        h('button.btn.btn-primary.btn-sm', { onclick: () => startRun(id, false, onStarted), title: 'Reads the whole pack again on Nemotron Ultra' }, icon('bolt', 14), 'Fresh read'))));

  const reqSummary = counts.total ? h('div.wk-reqsum', ['MET', 'PARTIAL', 'GAP', 'NEEDS_EVIDENCE'].map((s) => h('div.wk-reqsum-i', chip(s), h('span.num.small', String(counts[s] ?? 0)))), h('span.xs.muted', `${counts.total} requirements read from ${(d.documents || []).length || dash} documents`)) : null;

  root.replaceChildren(
    head,
    verdicts.length
      ? h('div.wk-verdicts', verdicts.map((v) => verdictCard(v, lots.find((l) => String(l.lot_no) === String(v.lot))?.title)))
      : h('div.card.wk-pad', h('div.h4', 'No verdict yet'), h('div.small.muted', 'Run a pack read: Pactovio reads every document in the pack, extracts each requirement with its page, checks the hard gates, and gives a bid or no-bid with reasons.')),
    ...[reqSummary, tabBar, pane].filter(Boolean));
  await showTab(active);
  return () => { if (paneCleanup) paneCleanup(); };
}
