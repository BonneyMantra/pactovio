// Design request: the customer's brief, each requirement checked against datasheets with citations,
// and the matched products with proposed quantities.
import { api, h, chip, cite, icon, toast, fmt } from '../ui.js';
import { opt, sectionHead, backLink } from './ops-kit.js';

export async function renderDesign(id, ctx) {
  const [d, quotes, products] = await Promise.all([api(`/design-requests/${id}`), api('/quotes').catch(() => ({ items: [] })), api('/products').catch(() => ({ items: [] }))]);
  const names = new Map((products.items || []).map((p) => [p.sku, p.name]));
  const reqs = Array.isArray(d.requirements) ? d.requirements : [];
  const matches = Array.isArray(d.matches) ? d.matches : [];
  const quote = (quotes.items || []).find((q) => q.design_request_id === d.id);
  const counts = reqs.reduce((a, r) => { const s = r?.result?.status || 'NEEDS_EVIDENCE'; a[s] = (a[s] || 0) + 1; return a; }, {});
  ctx.setCrumbs('Quotes', opt(d.customer, 'Design request'));

  const actions = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
  const rerun = h('button.btn.btn-secondary', { onclick: () => act(rerun, `/design-requests/${id}/match`, 'Match refreshed') }, icon('refresh'), 'Re-run match');
  const draft = h('button.btn.btn-primary', { onclick: () => act(draft, `/design-requests/${id}/quote`, 'Quote drafted', (r) => { if (r?.id) location.hash = `#/quotes/${r.id}`; }) }, icon('quote'), 'Draft quote');
  actions.append(rerun, quote ? h('a.btn.btn-primary', { href: `#/quotes/${quote.id}` }, 'Open quote', icon('arrow')) : draft);

  const brief = h('details.brief.card', h('summary', h('span', 'Customer brief'), h('span.xs.muted', 'from the original email')), h('pre.brief-text', opt(d.spec_text)));

  const citeList = [];
  const citeIdx = (c) => {
    if (!c) return null;
    const key = `${c.doc_id || c.doc}:${c.page}:${c.quote}`;
    let i = citeList.findIndex((x) => x.key === key);
    if (i < 0) { citeList.push({ key, ...c }); i = citeList.length - 1; }
    return cite(i + 1, `${c.doc || 'Datasheet'}${c.page ? `, p.${c.page}` : ''}: “${c.quote || ''}”`);
  };

  const reqTable = reqs.length ? h('div.table-wrap', h('table.table',
    h('thead', h('tr', h('th', 'Requirement'), h('th', 'Result'), h('th', 'Product'), h('th', 'Why'))),
    h('tbody', reqs.map((r) => h('tr',
      h('td', h('div', opt(r.text || r.value)), r.mandatory ? h('span.xs.muted', 'Mandatory') : null),
      h('td', chip(r?.result?.status || 'NEEDS_EVIDENCE')),
      h('td.mono', opt(r?.result?.sku)),
      h('td.small.ink2', opt(r?.result?.note), r?.result?.citation ? citeIdx(r.result.citation) : null)))))) : h('div.empty', 'No requirements extracted yet. Run the match.');

  const matchCards = matches.length ? h('div.grid.g2', matches.map((m) => h('div.card.match-card',
    h('div.match-top', h('div', h('div.mono.muted', opt(m.sku)), h('div.h4', { style: { marginTop: '2px' } }, names.get(m.sku) || m.name || m.sku || '—')),
      h('div.match-qty', h('div.xs.muted', 'Proposed qty'), h('div.num', { style: { fontSize: '22px', fontWeight: 550 } }, opt(m.proposed_qty)))),
    h('div', { style: { display: 'flex', gap: '6px', margin: '8px 0 10px' } }, chip(m.verdict === 'FIT' ? 'MET' : m.verdict === 'NO_FIT' ? 'GAP' : 'PARTIAL', m.verdict === 'FIT' ? 'Fit' : m.verdict ? m.verdict.replace(/_/g, ' ').toLowerCase() : 'Partial'),
      m.score != null ? h('span.chip.outline', `Score ${Math.round(Number(m.score) * 100)}`) : null),
    h('ul.reasons', (m.reasons || []).slice(0, 4).map((r, i) => h('li', r, m.citations?.[i] ? citeIdx(m.citations[i]) : null))),
    (m.gaps || []).length ? h('div.gaps', h('div.xs', { style: { fontWeight: 510, color: 'var(--bad)' } }, 'Gaps'), h('ul.reasons', m.gaps.map((g) => h('li', g)))) : null))) : h('div.empty', 'No products matched yet.');

  const sources = citeList.length ? h('div.card.sources', h('div.small', { style: { fontWeight: 510, marginBottom: '8px' } }, `${citeList.length} datasheet citations`),
    h('ol.cite-list', citeList.map((c) => h('li', h('span.mono', c.doc || 'Datasheet'), c.page ? h('span.muted', ` · p.${c.page}`) : null, h('div.small.ink2', `“${c.quote || ''}”`))))) : null;

  return h('div',
    backLink('#/quotes', 'All quotes'),
    h('div.page-head',
      h('div', h('div.xs.muted', { style: { marginBottom: '4px' } }, d.created_at ? `Design request · received ${fmt.date(d.created_at)}` : 'Design request'),
        h('h1.title', opt(d.subject, 'Design request')), h('div.sub', opt(d.customer))),
      actions),
    h('div.grid.g4', { style: { marginBottom: '16px' } },
      stat('Requirements', reqs.length), stat('Met', counts.MET || 0, 'ok'), stat('Partial', counts.PARTIAL || 0, 'warn'), stat('Gaps', (counts.GAP || 0) + (counts.NEEDS_EVIDENCE || 0), 'bad')),
    brief,
    sectionHead('Requirements checked against datasheets'), h('div.card', reqTable),
    sectionHead('Matched products'), matchCards,
    sources ? sectionHead('Sources') : null, sources);
}

function stat(k, v, tone) { return h('div.card.stat', h('div.k', k), h(`div.v${tone ? '.t-' + tone : ''}`, String(v))); }

async function act(btn, path, ok, after) {
  btn.disabled = true;
  try { const r = await api(path, { method: 'POST', body: {} }); toast(ok); if (after) after(r); else location.reload(); }
  catch (e) { toast(e.status === 429 ? 'Limit reached for this session. Try again shortly.' : e.message); }
  finally { btn.disabled = false; }
}
