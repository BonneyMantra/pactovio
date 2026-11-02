// Today: the morning brief. Counts, best tender matches, approvals waiting, newest intakes, recent runs.
import { api, h, icon, fmt, chip, empty, errorBox, skeleton } from '../ui.js';
import { dash, doorChip, sourceMark, senderName, fitRing, sectionTitle } from './work-kit.js';

function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

function stat(label, value, href, hint) {
  return h('a.card.stat.wk-stat', { href }, h('div.k', label), h('div.v', value == null ? dash : String(value)), hint ? h('div.xs.muted', hint) : null);
}

function matchRow({ tender, match }) {
  if (!tender) return null;
  return h('a.wk-match', { href: `#/tenders/${encodeURIComponent(tender.id)}` },
    fitRing(match?.fit_score),
    h('div.wk-match-main',
      h('div.wk-match-title', tender.title || 'Untitled tender'),
      h('div.xs.muted.wk-ellipsis', [tender.buyer || dash, tender.country, tender.value_eur ? fmt.moneyMajor(tender.value_eur, 'EUR') : null].filter(Boolean).join(' · ')),
      match?.fit_reason ? h('div.small.ink2.wk-clamp2', match.fit_reason) : null),
    h('div.wk-match-side', tender.deadline ? h('div.small.num', fmt.until(tender.deadline)) : h('div.small.muted', dash), chip(match?.status || 'new')));
}

function intakeRow(it) {
  return h('a.wk-intake', { href: `#/inbox/${encodeURIComponent(it.id)}` },
    sourceMark(it.source, 28),
    h('div.wk-intake-main',
      h('div.wk-intake-top', h('span.wk-sender', senderName(it.sender) || it.source), h('span.xs.muted', fmt.ago(it.received_at))),
      h('div.small.wk-ellipsis', it.title || '(no subject)'),
      it.classification?.reason ? h('div.xs.muted.wk-ellipsis', it.classification.reason) : null),
    doorChip(it));
}

function approvalRow(a) {
  return h('a.action-req.wk-appr', { href: `#/tenders/${encodeURIComponent(a.tender_id)}/answers` },
    h('span.label', icon('file'), h('span.wk-ellipsis', `Answer ${a.question_ref || ''} · ${a.tender_title || 'Tender'}`)),
    h('span.btn.btn-secondary.btn-xs', 'Review'));
}

function runRow(r) {
  const label = { pack_run: 'Pack read', design_match: 'Design match', scan: 'Nightly scan', audit: 'Claim audit' }[r.kind] || r.kind;
  return h('tr', h('td', label, r.replay ? h('span.chip.outline', { style: { marginLeft: '6px' } }, 'replay') : null),
    h('td', chip(r.status)), h('td.r.num', fmt.tokens(r.tokens_in)), h('td.r.num', r.cost_usd != null ? fmt.usd(r.cost_usd) : dash), h('td.r.muted', fmt.ago(r.started_at)));
}

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Today');
  const ws = ctx.session?.workspace?.name;
  root.append(h('div.page-head', h('div', h('h1.title', greeting()), h('div.sub', ws ? `Here's what changed for ${ws}.` : "Here's what changed today.")),
    h('a.btn.btn-secondary.btn-sm', { href: '#/inbox/new' }, icon('inbox'), 'New intake')));
  const body = h('div');
  root.append(body);
  body.append(skeleton(6));
  let t;
  try { t = await api('/today'); } catch (e) { body.replaceChildren(errorBox(e)); return; }
  const c = t.counts || {};
  const matches = (t.top_matches || []).filter((m) => m && m.tender);
  const intakes = t.intakes || [];
  const approvals = t.approvals || [];
  const runs = t.recent_runs || [];
  body.replaceChildren(
    !intakes.length && !runs.length && !matches.length ? h('section.card.workspace-start', h('span.access-step', 'YOUR WORKSPACE IS READY'), h('h2.h3', 'Start with what you know'), h('p.small.ink2', 'Add your company evidence, then bring in a tender or request. Pactovio uses the information you provide; your new workspace starts without sample documents or invented claims.'), h('div.workspace-start-actions', h('a.btn.btn-primary', { href: '#/evidence' }, icon('evidence'), 'Add company evidence'), h('a.btn.btn-secondary', { href: '#/inbox/new' }, icon('inbox'), 'Add a request'), h('a.btn.btn-ghost', { href: '#/connections' }, icon('plug'), 'Connect a mailbox'))) : null,
    h('div.grid.g4.wk-stats', stat('New matches', c.new_matches, '#/tenders'), stat('Open intakes', c.open_intakes, '#/inbox'), stat('Approvals waiting', c.approvals_pending, '#/agent', approvals.length ? 'Drafted answers' : null), stat('Runs today', c.runs_today, matches[0] ? `#/tenders/${encodeURIComponent(matches[0].tender.id)}` : '#/tenders')),
    h('div.wk-two',
      h('div',
        sectionTitle('Top matches', h('a.small.muted', { href: '#/tenders' }, 'All tenders')),
        h('div.card.wk-list', matches.length ? matches.map(matchRow) : empty('No matches yet', 'The nightly scan reads new tenders from TED, eTenders and Find a Tender and scores them against your profile.')),
        sectionTitle('Latest in the inbox', h('a.small.muted', { href: '#/inbox' }, 'Open inbox')),
        h('div.card.wk-list', intakes.length ? intakes.slice(0, 6).map(intakeRow) : empty('Inbox is quiet', 'Add a request manually or connect your mailbox to start receiving work.'))),
      h('div',
        sectionTitle('Needs your approval', approvals.length ? h('span.chip.warn', String(approvals.length)) : null),
        h('div.wk-appr-list', approvals.length ? approvals.slice(0, 6).map(approvalRow) : h('div.card', empty('Nothing waiting', 'Drafted answers and agent actions appear here before anything is sent.'))),
        (t.closing_soon || []).length ? [sectionTitle('Closing soon'), h('div.card.wk-list', t.closing_soon.map((x) => h('a.wk-close', { href: `#/tenders/${encodeURIComponent(x.tender_id)}` }, h('div.wk-ellipsis.small', x.title || dash), h('span.small.num', x.days_left != null ? `${x.days_left}d` : dash))))] : null,
        sectionTitle('Recent runs'),
        h('div.card', runs.length ? h('div.wk-scroll', h('table.table', h('thead', h('tr', h('th', 'Run'), h('th', 'Status'), h('th.r', 'Tokens'), h('th.r', 'Cost'), h('th.r', 'When'))), h('tbody', runs.slice(0, 6).map(runRow)))) : empty('No runs yet')))),
  );
}
