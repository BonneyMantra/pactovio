// Static content for the landing page. Live-tested flags come from scripts/connector-e2e.ts on 30 Oct 2026.
const SI = (slug) => `https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/${slug}.svg`;

export const CONNECTORS = [
  { name: 'Gmail', role: 'Email', slug: 'gmail', brand: '#EA4335', live: true },
  { name: 'Outlook', role: 'Email', text: 'Outlook', brand: '#0A64AD' },
  { name: 'Slack', role: 'Chat', slug: 'slack', brand: '#4A154B', live: true },
  { name: 'Microsoft Teams', role: 'Chat', text: 'Teams', brand: '#5059C9' },
  { name: 'HubSpot', role: 'CRM', slug: 'hubspot', brand: '#FF7A59' },
  { name: 'Salesforce', role: 'CRM', slug: 'salesforce', brand: '#00A1E0', live: true },
  { name: 'Google Drive', role: 'Files', slug: 'googledrive', brand: '#1FA463', live: true },
  { name: 'Dropbox', role: 'Files', slug: 'dropbox', brand: '#0061FF', live: true },
  { name: 'Google Calendar', role: 'Calendar', slug: 'googlecalendar', brand: '#4285F4', live: true },
  { name: 'Outlook Calendar', role: 'Calendar', text: 'Outlook', brand: '#0A64AD' },
  { name: 'Jira', role: 'Projects', slug: 'jira', brand: '#0052CC', live: true },
  { name: 'Asana', role: 'Projects', slug: 'asana', brand: '#F06A6A', live: true },
  { name: 'DocuSign', role: 'Signing', text: 'DocuSign', brand: '#4C00FF' },
  { name: 'QuickBooks', role: 'Accounting', slug: 'quickbooks', brand: '#2CA01C' },
  { name: 'Xero', role: 'Accounting', slug: 'xero', brand: '#13B5EA' },
].map((c) => ({ ...c, src: c.slug ? SI(c.slug) : null }));

export const MODELS = [
  { name: 'Nemotron Ultra', sub: '550B', role: 'Reads the whole pack and writes the verdict', slug: 'nvidia', brand: '#76B900' },
  { name: 'Nemotron Super VL', sub: 'Vision', role: 'Drives the agent and reads drawings', slug: 'nvidia', brand: '#76B900' },
  { name: 'Nemotron Lightning', sub: 'Fast', role: 'Classifies email and drafts answers', slug: 'nvidia', brand: '#76B900' },
  { name: 'Qwen3 Embedding', sub: '8B', role: 'Ranks your evidence for each requirement', text: 'Qwen' },
  { name: 'NeMo Guardrails', sub: 'Audit', role: 'Checks drafted claims in a Nebius job', slug: 'nvidia', brand: '#76B900' },
].map((m) => ({ ...m, src: m.slug ? SI(m.slug) : null }));

export const AGENTS = [
  { name: 'Claude', role: 'Desktop and Code', slug: 'claude', brand: '#D97757' },
  { name: 'Cursor', role: 'Editor agents', text: 'Cursor' },
  { name: 'Hermes Agent', role: 'Runs on your Mac', text: 'Hermes' },
  { name: 'OpenAI', role: 'Agents SDK', slug: 'openai', brand: '#000000' },
  { name: 'Any MCP client', role: 'POST /mcp', text: 'MCP' },
].map((a) => ({ ...a, src: a.slug ? SI(a.slug) : null }));

// "Reliable verdicts" list: each item swaps the answer panel. [n] marks become citation chips.
export const CAPS = [
  { t: 'Read the whole pack', q: 'What does the Teagasc pack actually ask for?', a: 'Three lots of web application support across <b>7 documents</b>: the request for tenders, a requirements PDF with an architecture diagram, clarifications and three response forms [1]. Clarifications override the original text where they conflict [2].', src: ['P', 'D'], act: 'Open the requirements matrix' },
  { t: 'Check every mandatory gate', q: 'Do we pass the mandatory gates?', a: 'All but one. Certifications and declarations are met [1]. Public liability must be <b>€6.5M</b> and the profile holds <b>€6.0M</b>, but the pack allows cover to be arranged after award, so it is a condition, not a veto [2].', src: ['P', 'E'], act: 'Ask the broker for a €6.5M cover quote' },
  { t: 'Score fit 0–100', q: 'Should we bid?', a: 'Bid with conditions on all three lots. The score is held back by the insurance condition [1] and a <b>20 working-day</b> take-on against a six-week precedent on Lots 2 and 3 [2].', src: ['P'], act: 'Approve the bid decision' },
  { t: 'Map requirements to evidence', q: 'Where is our evidence for the SLA requirement?', a: 'Matched to the managed-service case study and the current support contract [1][2]. Each requirement row links to the exact page of the evidence it used.', src: ['D', 'E'], act: 'Review the matrix' },
  { t: 'Strike unsupported claims', q: 'Is the drafted answer safe to send?', a: 'One sentence claimed a headcount that is not in your evidence, so it was struck and flagged <b>needs evidence</b> [1]. Every remaining sentence traces to a document [2].', src: ['E'], act: 'Attach the missing evidence' },
  { t: "Fill the buyer's own form", q: 'Can you fill the Lot 1 response form?', a: 'Done. Rows are matched by reference number and Yes / No / Partial is set from the matrix; every other part of the buyer\'s file is left untouched [1].', src: ['P'], act: 'Download the filled form' },
  { t: 'Classify every inbound email', q: 'What came in overnight?', a: 'One design request from a port authority, one RFQ for spares, and two vendor newsletters marked <b>ignored</b> [1]. The design request is already matched to your catalogue [2].', src: ['G'], act: 'Open the design request' },
  { t: 'Match design requests to your catalogue', q: 'Can we meet the berth monitoring spec?', a: 'Four of five needs are covered by catalogue products with datasheet citations [1][2]. Modbus RTU on the gateway is a gap, so it is flagged rather than promised [3].', src: ['D', 'P'], act: 'Draft the quote' },
  { t: 'Draft the quote', q: 'Draft a quote for the port authority.', a: 'Drafted: six lines with tax handled for the buyer\'s country [1]. Prices come from your catalogue and are marked where they are indicative [2].', src: ['D'], act: 'Post the quote for approval in #sales' },
  { t: 'Ask before acting', q: 'Send the quote to the buyer.', a: 'I never send on my own. Here is the draft reply in Gmail with the quote attached, waiting for your confirm [1].', src: ['G', 'S'], act: 'Save the reply as a Gmail draft' },
  { t: 'Find new tenders nightly', q: 'Anything new that fits us?', a: 'The nightly scan read the European and UK feeds and found one notice above your fit threshold [1]. Its pack is downloaded and queued for a read [2].', src: ['P'], act: 'Read the pack now' },
];

export const MARKS = { G: ['#EA4335', 'G'], D: ['#1FA463', 'D'], P: ['#21201c', 'P'], S: ['#4A154B', 'S'], E: ['#00759b', 'E'] };
