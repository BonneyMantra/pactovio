# Pactovio

The pre-sales engine for technical B2B suppliers. Three doors in, one engine, outputs a bid team can use:

- Doors: public tenders found by a nightly scan, inbound RFPs and RFQs (upload, paste, mailbox), design requests from customers.
- Engine: read the whole pack, extract every requirement, decide bid or no-bid per lot, match requirements to the company's evidence, draft answers and a priced quote, check every claim, ask a person to approve.
- Outputs: the buyer's own response form filled in (DOCX), a requirement matrix with sources, per-lot verdicts, a priced quote (DOCX and XLSX), events to the team's tools, and a 24x7 agent you can chat with or reach over MCP.

Built for the Nebius x NVIDIA hackathon, track Best Apps and Agents. Hosted target: https://pactovio.pages.dev (landing, /pricing) and https://pactovio.pages.dev/app. Customer access in this version uses email-code signup/login, a private company workspace, resumable onboarding, customer evidence uploads and catalogue prices. Rollout requires the additive customer migration and configured email/Composio services; see [customer setup and API contract](apps/api/CUSTOMER-AUTH.md). Billing remains Dodo Payments test mode. Existing sample-company data is retained internally and is not available through customer sessions.

**The product interface** (`apps/front/public`, plain HTML, CSS and ES modules on the live API, no build step):

| Screen | What it shows (all live data) |
|---|---|
| Today | Counts that open filtered views, top tender matches with fit, newest intakes with the Lightning model's one-line reason, approvals waiting, recent runs with tokens and cost |
| Inbox | Every intake by door (RFQ, RFP, design request, tender, ignored) with confidence; paste-in composer |
| Tenders → detail | Per-lot verdict with reasons citing document and page, every gate, the requirement matrix (filters, search, page citations), drafted answers with struck claims and a NeMo Guardrails panel, the buyer's own form filled and downloadable, the run's steps with model, tokens and cost, buyer intel |
| Quotes | Design requests matched against datasheets (MET / PARTIAL / GAP with citations) and quote documents with DOCX export |
| Agent | The 24x7 agent: streaming chat over WebSocket, tool calls, citations, approve / decline cards, proactive inbox |
| Connections | 15 connectors by category with live status and a live event stream |
| Evidence, Catalogue, Company settings, Billing & usage, How it works, Pricing, Help | Upload and index company documents; enter product prices; resume/edit company setup; plans, test checkout and usage limits |

## How it works

```
 scan (cron 06:00 MYT)  upload / paste / mailbox  design request
        \                     |                      /
         v                    v                     v
   Cloudflare Worker  pactovio-api  (Hono + zod OpenAPI, /api /v1 /mcp /webhooks /ics)
        |                |                  |                |
   Workflows         Durable Object      Queues           D1 + R2 + KV
   PackRun / Scan /  AgentHub (chat,     pactovio-events  tenders, matrix,
   Intake            alarms, SSE)        webhook + app    verdicts, evidence,
                                         fan-out          ledger | pack files | cache
        |
        v
   Nebius Token Factory (Nemotron + Qwen3 embeddings)     Tavily (buyer intel)
   Nebius Serverless Job: NeMo Guardrails audit (CLI-started)
```

| Piece | What it does |
|---|---|
| `apps/api` | One Worker `pactovio-api`. Routes, Workflows (`PackRunWorkflow`, `ScanWorkflow`, `IntakeWorkflow`), `AgentHub` Durable Object (SQLite, WebSocket hibernation, alarms), queue consumer, cron `0 22 * * *` UTC. `workers_dev` is off. |
| `apps/front` | Cloudflare Pages project `pactovio`: `_worker.js` sends `/api /v1 /mcp /webhooks /ics /dev` to the Worker over a service binding and everything else to the static site: landing, `/pricing`, `/privacy`, `/terms` and the product app at `/app`. |
| `packages/engine` | Pack run pipeline, gates in code, evidence matching, verdicts, drafting, claim check, form fill, buyer intel, caps, replay. |
| `packages/sources`, `packages/pack` | TED v3, UK Find a Tender, eTenders (anonymous pack download), unzip and text extraction for PDF, DOCX, XLSX; form detection. |
| `packages/quote` | Design request parsing, catalogue match, pricing and tax rules, quote export. |
| `packages/agent` | Streaming tool loop, 17 tools, confirmation gating (state-changing tools return a pending card, a person confirms). Same tools over MCP. |
| `packages/connectors` | 15 connectors through Composio, live email intake. See Connectors. |
| `packages/billing` | Dodo test-mode checkout, webhook, credit ledger, caps, real `/limits`. |
| `jobs/audit` | NeMo Guardrails audit job. |
| `selfhost` | Mac desk agent: Hermes in an NVIDIA OpenShell sandbox. |

### Which model does what (Nebius Token Factory only)

| Model | Used for |
|---|---|
| `nvidia/Nemotron-3-Ultra-550b-a55b` | Whole-pack read, requirement extraction (section by section), per-lot verdict reasoning. The pack text goes first in every prompt of a run so later calls hit the prompt cache. |
| `nvidia/Nemotron-3.5-Super-VL` | Agent tool loop (chat and MCP), drawings and scanned pages, evidence scans, the NeMo self-check judge. If it is not served (it returned 404 for a few minutes on 30 Oct) the agent falls back to `nvidia/nemotron-3-super-120b-a12b`, then to Ultra; vision falls back to `google/gemma-3-27b-it`. |
| `nvidia/Nemotron-3_5-Lightning` | Nightly notice triage (flex tier), answer drafting, email classification, buyer-intel summaries. Thinking off. |
| `Qwen/Qwen3-Embedding-8B` | Evidence and requirement embeddings, ranked by cosine in code (there is no reranker). Kestrel datasheet rows use 256-dim Matryoshka vectors; `cosine()` returns 0 for vectors of different length. |

Structured output is JSON Schema from zod, validated, one retry with the validation error. Every model call is a row in `run_steps` (model, purpose, input, output and cached tokens, ms, cost). Costs use a price table that is an estimate, not the Nebius price list.

### Decisions are mostly code, not model

Gates (turnover, insurance cover, certifications, references) are checked in code against the company profile as of the submission deadline. Requirement status (MET, PARTIAL, GAP, NEEDS_EVIDENCE) comes from similarity thresholds and explicit rules. Per-lot BID, NO_BID or CONDITIONAL is decided by code; the model only writes the reasoning. Every sentence of a drafted answer is split into claims (certifications, SLAs, headcounts, client names, money, dates) and each is checked against the evidence in code; unsupported ones are struck and tagged.

On the real Teagasc pack (public tender, 3 lots, EUR 5.95M) the sample company's insurance cover (EUR 6.0M) is below the EUR 6.5M the pack requires, so all three lots come out CONDITIONAL rather than BID. That is the intended behaviour, not a bug.

## NeMo Guardrails audit

Drafted answers are audited by NeMo Guardrails 0.24.1 running as a Nebius Serverless Job. It checks claims with a NeMo regex output rail, our own Colang flow plus action (every concrete value must appear in that answer's evidence), and NeMo's `self check facts` with Nemotron 3.5 Super VL as judge; a 10-prompt red team runs in the same job. `result_json` labels which verdict came from NeMo and which from our code. Details: `docs/NEMO.md`.

**It is started by hand, on demand, from the CLI**: `scripts/start-audit-job.sh` creates `pactovio-audit-<timestamp>` with `nebius --profile hackathon-jobs-sa ai job create`, the job reads the queued `audits` rows from the app, posts results back to `/api/ingest/audit`, and exits. `scripts/start-audit-job.sh --delete` removes finished jobs. **There is no schedule that starts it**, and no Worker ever calls the Nebius control plane. The engine only queues `audits` rows (status `queued`) after drafting.

**Run on 30 Oct against production:** one job on Nebius (`cpu-d3`, 2 vCPU, python:3.12-slim, about 5 minutes including image pull and `pip install`) audited the 5 queued answers of the Met Eireann pack: 1 claim flagged by the regex rail, 1 unsupported by our check and NeMo's self check; red team 10 of 10 caught. The results are stored on the `audits` rows and returned by `GET /api/audits/{id}` and `/api/limits`. The finished job was deleted afterwards.

## Customer access and limits

Sign in or create an account with a six-digit email code. New customers receive an empty, private workspace and complete company setup before entering the app. Company details are saved between visits; evidence, products, requests, quotes, agent threads and connected accounts belong to that workspace. Customer cookies are opaque, hashed server-side, HttpOnly, Secure and revocable. Legacy anonymous sample cookies do not authenticate customer APIs.

Per customer browser session: 2 fresh pack reads, 3 Tavily buyer refreshes and 10 agent messages a minute. Globally: one fresh pack run in flight, Tavily 25/day and 150/month, and a hard **$0.25/day model spend cap** with a kill switch. Budget exhaustion is an error, not a fabricated answer. New customer workspaces have no recorded replays. Scheduled scans exclude retained samples and customers whose setup is incomplete. `GET /api/limits` returns the current counters and budget.

Each customer connects their own tools through Composio. The project callback verifier must be configured before production customer connections are enabled; credentials and shared demo accounts are never adopted into customer workspaces. See [configuration, migration and verification](apps/api/CUSTOMER-AUTH.md).

Catalogue entry currently supports 26 currencies with two decimal minor units; unsupported currency formats are rejected. Customers supply their own prices and datasheets. Quotes without configured tax rules exclude tax and require supplier confirmation of applicable taxes and commercial terms.

## Cost of one pack read (measured, not projected)

| Run | Input tokens (cached) | Output tokens | Time | Estimated cost |
|---|---|---|---|---|
| Fresh run on Met Eireann coastal visibility sensors pack (107 pages), production, 30 Oct | 2.64M (2.26M cached) | 100K | 2 m 49 s | about $0.73 |
| Recorded live run on the Teagasc pack (205 pages, 3 lots, bundled as the replay) | 4.68M | 187K | about 4 min | about $1.23 |

The cost is dominated by Ultra reading the pack once per section group with a cached prefix. Prices are estimates (see above).

## Connectors

15 connectors through Composio managed auth, two per category: Gmail and Outlook, Slack and Microsoft Teams, HubSpot and Salesforce, Google Drive and Dropbox, Google Calendar and Outlook Calendar, Jira and Asana, DocuSign, QuickBooks and Xero. Each does one real job (mail trigger to classified intake with reply drafted never sent, chat posts with approve and decline links, a deal per bid, uploads of filled forms and quotes, calendar events for deadlines, a task per matrix gap, a quote sent for signature, an estimate from an approved quote).

**Live-tested on 30 Oct 2026 against real connected test accounts** (`npx tsx scripts/connector-e2e.ts all --api https://pactovio.pages.dev`): 9 checks passed across 8 connectors, 0 failed. Each check performs the real action, reads the object back through Composio, then cleans up.

| Connector | Live check | Result |
|---|---|---|
| Gmail | create draft, read back, delete | PASS |
| Gmail real-time intake | email arrives, Composio trigger hits `/webhooks/composio`, Nemotron Lightning classifies it, intake created | PASS (classified `design`, 24 s end to end) |
| Slack | post message, read back, delete | PASS |
| Salesforce | create opportunity, read back, delete | PASS |
| Google Drive | upload file, read back, delete | PASS |
| Dropbox | upload file, read back, delete | PASS |
| Google Calendar | create event, read back, delete | PASS |
| Jira | create task, read back, delete | PASS |
| Asana | create task, read back, delete | PASS |

Event rules also fired on their own in production on 30 Oct, with no one clicking: a finished pack read opened gap tasks in Jira and Asana (`run.completed` → `create_gap_tasks`); a drafted quote was uploaded to Google Drive and Dropbox (`quote.ready` → `upload_artifacts`) and the agent posted "Quote ready" plus both lot verdicts to the team's Slack channel. A no-bid verdict correctly pushed nothing to the CRM (`sync_bid` only runs for Bid or Bid with conditions).

Built and fixture-tested but **not live-tested**: HubSpot (test account not finished in time), Outlook and Outlook Calendar (Microsoft account creation was refused for the test persona), Microsoft Teams (needs a Microsoft 365 work account), QuickBooks (Intuit sandbox signup was refused), DocuSign and Xero (need our own OAuth apps). Pactovio uses its own Composio project, so its webhook subscription and connected accounts are isolated from any other product.

## Agent

The 24x7 agent is the `AgentHub` Durable Object: a streaming tool loop on Nemotron 3.5 Super VL, proactive messages from events (new match, run finished, approval requested), a morning digest on a Durable Object alarm, WebSocket and SSE delivery. State-changing tools never execute directly: they return a pending card and a person approves in chat or from a signed link. The same tools are served over MCP at `/mcp` (streamable HTTP, API key).

**Mac desk agent (optional, `selfhost/`, `docs/SELF-HOST.md`).** Hermes Agent 0.15.1 in its own profile runs inside an NVIDIA OpenShell sandbox on Docker, with a default-deny network policy that allows only Token Factory, `pactovio.pages.dev` and Slack, tools through Pactovio's MCP, proactive events over an outbound SSE stream. Verified locally against a dev server; not run against the hosted URL, and the Slack gateway has not been tried live (no Slack tokens). NemoClaw was evaluated and not used: it needs an always-on host with Docker, so the hosted agent is the Durable Object.

## Billing (Dodo Payments, test mode only)

Plans: Scout (free, 3 credits), Team (USD 149 a month, 150 credits), Business (USD 449 a month, 600 credits), credit pack (100 credits, USD 40). A pack read costs 1, 2 or 4 credits by page count, a design match 1, a buyer refresh 1. Checkout returns a Dodo test checkout URL; the webhook is verified with Standard Webhooks signatures and is idempotent. No real payment is possible. Sample workspaces are shared by judges and never charged. Usage is also sent to a Dodo meter, but no metered product is attached, so the credit ledger is the billing.

## Fine-tuned tender-notice extractor (LoRA on an NVIDIA open model)

A real, measured LoRA fine-tune of `nvidia/Llama-3.1-Nemotron-Nano-4B-v1.1` (NVIDIA Open Model License) that turns a tender notice's text into
five structured fields: submission deadline, lot count, CPV division of the main subject, whether an estimated value is stated, and buyer country.

- Data: 2,188 EU TED contract notices (v3 search API, `notice-type=cn-standard`, published since 2026-08-01, pulled by the job itself). TED
  publishes under the Commission's reuse policy (Decision 2011/833/EU); per TED's legal notice, procurement notices can be freely reused
  commercially or not, and the editorial content is CC BY 4.0. Labels come from TED's structured fields; the input is the buyer's own text
  rendered like the notice form (buyer, title, description, lot titles and descriptions, the time-limit and estimated-value lines).
  TED's translated `notice-title` is not used because it embeds the country and CPV category. No model-written text is in the data.
- Split by buyer, so no buyer appears in two splits: train 1,868, val 100, test 220. Dedupe by notice id and by normalised input text
  (1 duplicate dropped); overlap between splits: 0 ids, 0 inputs, 0 buyers. The test notices were never seen in training.
- Training: one Nebius AI Cloud Serverless Job (`aijob-e00eje0fdntak0kj5a`, `pactovio-finetune-1030-2253`, deleted after completion), 1x H100 in
  eu-north1, LoRA r=16 on all linear layers, 2 epochs, 232 steps, 315 s of training, about 9.3 min running. Cost: an estimated $0.5-0.7 at an assumed
  H100 rate; we did not read the billing figure. No Token Factory spend.
- Evaluation: the same 220 held-out test notices and the same prompt for the base model (zero-shot) and the tuned model, greedy decoding.

| Test set (n=220) | Base zero-shot | Tuned |
|---|---|---|
| Valid JSON | 217 | 220 |
| Deadline exact match | 95.0% | 100% |
| Lot count | 92.7% | 100% |
| Estimated value stated (F1) | 69.8% | 100% |
| CPV division (accuracy / macro-F1) | 12.3% / 3.2% | 58.2% / 33.5% |
| Buyer country (accuracy / macro-F1) | 29.1% / 9.2% | 94.6% / 85.8% |
| All five fields exact | 3.6% | 55.0% |

Read it honestly: most of the base model's gap is format-following (it often returns ISO-2 country codes, drops a key, or invents a CPV
division); the deadline score for the base counts a date prefix as correct. The hard field is CPV division, where the tuned model reaches 58%
against 24.5% for always answering the most common division. Deadline and value lines are present in the notice text, so those fields test
extraction, not inference. Results are in `jobs/finetune/results.json`; run with `scripts/start-finetune.sh` (no secrets needed).

This is a measured experiment alongside the product: the live app still uses the Token Factory Nemotron models above, and the adapter is not served.

## Run it locally

```bash
npm install
cd apps/api
# put NEBIUS_API_KEY (and optionally TAVILY_API_KEY) in .env.local, gitignored; dev.sh turns it into .dev.vars
npx tsx scripts/seed-packs.ts --state .wrangler/state     # migrates, seeds the sample companies, extracts the real packs
npx tsx scripts/seed-samples.ts --apply --local           # company evidence and the Kestrel catalogue
PORT=8788 npm run dev                                     # http://localhost:8788/api/health
cd ../.. && npm test && npm run typecheck
```

The real tender packs are public documents from eTenders, TED and Find a Tender. They are not committed; `fixtures/packs/SOURCES.md` lists each source. Deploy: `wrangler deploy` for the Worker, `wrangler pages deploy public --project-name pactovio` from `apps/front`, then `npm run seed:packs:remote` and the remote seed scripts in `apps/api/package.json`.

## Cut or not done

- Connectors: 8 of 15 live-tested, 9 checks (see Connectors); HubSpot, Outlook, Outlook Calendar, Teams, QuickBooks, DocuSign and Xero are fixture-tested only.
- Scanned PDFs without a text layer are rejected on evidence upload (upload PNG or JPG); PDF image pages are not rendered to PNG for the vision step.
- Form fill covers table rows keyed by reference number; free-form content controls are untouched.
- Embeddings are slow on the shared link (about 25 s a request), noticeable on evidence upload.
- Paid customer billing is not enabled: Dodo checkout remains test mode. Production customer rollout needs verified email delivery, the customer migration and the Composio callback verifier.

## Sample data

Harbour Digital Ltd (Cork) and Kestrel Sensing Ltd (Galway) are fictional and labelled "Sample company". Tenders and their documents are real public notices.

MIT licensed.
