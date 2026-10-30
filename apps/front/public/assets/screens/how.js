// How it works, inside the app: the five stages a tender, RFQ or design request goes through, and which model does each.
import { h, icon } from '../ui.js';

const STEPS = [
  { n: '01', title: 'Everything arrives in one inbox', body: 'Every email that reaches a connected mailbox is classified by NVIDIA Nemotron Lightning as an RFQ, RFP, design request, tender or noise, with a one-line reason. Public tenders arrive from the nightly scan of TED, eTenders and Find a Tender.', where: '#/inbox', cta: 'Open the inbox' },
  { n: '02', title: 'The whole pack is read', body: 'NVIDIA Nemotron Ultra, served by Nebius Token Factory, reads every document in the pack, clarifications first, and extracts each requirement with its document and page. Drawings and scanned pages go to Nemotron Super VL.', where: '#/tenders', cta: 'See a verdict' },
  { n: '03', title: 'Every gate is checked against your records', body: 'Turnover, insurance, certificates and references are compared in code with your own evidence, ranked by Qwen3 Embedding 8B. The verdict is Bid, Bid with conditions or No bid, with reasons that cite the page.', where: '#/evidence', cta: 'View your evidence' },
  { n: '04', title: 'Answers and quotes are drafted, then checked', body: 'Pactovio drafts answers and quotes from your evidence and catalogue. Any sentence the evidence does not support is struck before you see it, and NeMo Guardrails audits the drafts again in a Nebius job.', where: '#/quotes', cta: 'Open quotes' },
  { n: '05', title: 'Nothing leaves without you', body: 'The agent posts approval cards in the app and in Slack. Replies are saved as drafts, never sent. Approved work flows to your CRM, files, calendar and project tools through Composio.', where: '#/agent', cta: 'Talk to the agent' },
];

export async function render(root, _params, ctx) {
  ctx.setCrumbs('How it works');
  root.append(
    h('div.page-head', h('div', h('h1.title', 'How it works'), h('div.sub', 'From an email or a tender notice to a decision and a drafted answer.'))),
    h('div.grid', { style: { gap: '12px' } }, STEPS.map((s) => h('div.card.pv-how', { style: { padding: '20px 22px', display: 'grid', gridTemplateColumns: '56px 1fr auto', gap: '16px', alignItems: 'start' } },
      h('span.mono', { style: { color: s.n === '01' ? 'var(--accent)' : 'var(--ink-3)', paddingTop: '3px' } }, s.n),
      h('div', h('div.h4', s.title), h('p.small.ink2', { style: { margin: '6px 0 0', maxWidth: '62ch' } }, s.body)),
      h('a.btn.btn-secondary.btn-sm', { href: s.where }, s.cta, icon('arrow', 14))))),
  );
}
