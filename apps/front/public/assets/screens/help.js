// Help, inside the app: short answers to the questions a first-time visitor (or judge) asks, each with where to look.
import { h, icon } from '../ui.js';

const FAQ = [
  ['What is a credit?', 'Reading a tender pack costs 1, 2 or 4 credits depending on its size; matching a design request or refreshing buyer research costs 1. Email triage, drafting, agent chat and connectors are included.', '#/pricing', 'See pricing'],
  ['Are there limits in this demo?', 'Each browser session can start 2 fresh pack reads and 3 buyer research refreshes, and send 10 agent messages a minute. Replaying a recorded read is free and unlimited.', '#/settings', 'See your usage'],
  ['Does Pactovio send anything on its own?', 'No. Replies are saved as drafts, never sent. Anything that leaves the workspace waits for an approval card in the Agent or in Slack.', '#/agent', 'Open the agent'],
  ['Where does my data live?', 'In this workspace only: Cloudflare D1 for records and R2 for documents. Models run on Nebius Token Factory; nothing is used for training.', '/privacy', 'Read the privacy policy'],
  ['How do I connect my tools?', 'Open Connections, choose a tool and sign in with that tool. Gmail and Outlook start classifying new email immediately; the others act when a verdict, quote or run is ready.', '#/connections', 'Open connections'],
  ['How do I switch company?', 'Use the workspace menu at the bottom of the sidebar. Two sample companies are available alongside the main workspace.', null, null],
  ['Can other agents use Pactovio?', 'Yes. The same tools are available over MCP at /mcp with an API key, and a desk agent can run on a Mac inside NVIDIA OpenShell.', '#/how', 'How it works'],
];

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Help');
  root.append(
    h('div.page-head', h('div', h('h1.title', 'Help'), h('div.sub', 'Short answers, and where to look in the product.'))),
    h('div.card', { style: { padding: '4px 0' } }, FAQ.map(([q, a, href, cta], i) => h('details.pv-faq', { open: i === 0 ? true : null, style: { padding: '14px 20px', borderBottom: i < FAQ.length - 1 ? '0.5px solid var(--line-soft)' : '0' } },
      h('summary', { style: { cursor: 'pointer', fontWeight: 510, listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' } }, q, icon('down', 14)),
      h('p.small.ink2', { style: { margin: '8px 0 0', maxWidth: '68ch' } }, a),
      href ? h('a.small', { href, style: { display: 'inline-flex', gap: '6px', alignItems: 'center', marginTop: '8px', fontWeight: 510 } }, cta, icon('arrow', 14)) : null))),
  );
}
