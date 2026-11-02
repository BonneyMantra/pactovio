# Pactovio API (handoff for the UI)

One Cloudflare Worker, `pactovio-api` (Hono). The UI imports **`@pactovio/contracts`** (zod schemas and TS types) and **`@pactovio/client`** (typed fetch client). Both are framework-free and published as TS source in the npm workspace.

```ts
import { createClient } from '@pactovio/client';
import type { TodayFeed, Tender } from '@pactovio/contracts';

const api = createClient({ baseUrl: 'http://localhost:8787' });   // '' = same origin (Pages)
const today = await api.getToday();                                // typed, zod-validated
const matrix = await api.getMatrix({ params: { id: 'tnd_sample_teagasc_p4941' } });
const stop = api.subscribe('/events/stream', (e) => console.log(e.event, e.data));
const ws = new WebSocket(api.agentWsUrl());                        // frames: AgentWsMessage
```

Every endpoint is one method named by its `id` in the table below. Method args: `{ params, query, body }` (only the ones the endpoint has). Errors throw `ApiError { status, code, message }`.

## Run locally

```bash
npm install
npm run db:migrate:local      # creates the local D1 under apps/api/.wrangler
npm run seed:local            # idempotent sample data (2 companies, 5 tenders, Teagasc matrix, Kestrel catalogue)
npm run dev:api               # http://localhost:8787  (builds .dev.vars from apps/api/.env.local, never echoes it)
                              # port busy (another product's workerd)? PORT=8788 npm run dev:api
curl localhost:8787/api/health
curl localhost:8787/v1/openapi.json
open http://localhost:8787/dev/   # bare index of GET endpoints
npm test && npm run typecheck
```

Secrets come from the vault only: `~/.claude/vault/inject.sh get NEBIUS_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID --dir apps/api` (writes `apps/api/.env.local`, gitignored). `dev.sh` copies the non-Cloudflare names into `.dev.vars` for the Worker.

Cookies: the API sets `pv_s` (HttpOnly, SameSite=Lax). From a dev server on another origin use `credentials: 'include'` (the client does) and proxy `/api` to :8787 to stay same-origin.

## Conventions

- JSON is **snake_case**, mirroring D1 columns. A column `foo_json` is exposed as the parsed field `foo`; INTEGER flags (`sample`, `is_form`, `replay`, `active`) are booleans.
- **Money is integer minor units** (cents) everywhere (`unit_price_minor`, `total_minor`, `*_minor`). One documented exception: `tenders.value_eur` is **whole euros** (mirrors TED).
- IDs are prefixed lower-case ULIDs (`tnd_`, `run_`, `ans_`). Seed rows use readable ids containing `_sample_`.
- Errors are always `{ error, code? }`: `validation` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `not_implemented` (501), `internal` (500).
- Times are ISO 8601 UTC. Render in the viewer's timezone; deadlines in the sample data are real tender deadlines (GMT).
- **Sample data**: ids contain `_sample_`; `tenders.raw.sample`, `evidence.meta.sample` and `connectors.meta.sample` are `true`. Lanes replace sample rows when real ones exist. Teagasc (`tnd_sample_teagasc_p4941`) has the richest set: 10 requirements (MET/PARTIAL/GAP/NEEDS_EVIDENCE), 3 verdicts (BID, BID, CONDITIONAL), 3 drafted answers with claim checks, a completed replay run with 4 steps, buyer intel and 7 evidence items.

## Customer sessions

`/api/*` requires a verified email-code customer session (`pv_customer`), apart from explicitly public health/ingest routes. Legacy anonymous `pv_s` cookies and sample API keys do not authenticate customers. See [the PAC-010 backend contract](../apps/api/CUSTOMER-AUTH.md) for email-code endpoints, resumable company onboarding, error/status handling, Composio callback verification and coordinator migration/configuration requirements. `/v1/*` retains Bearer API-key authentication for private workspaces. New customers start with truthful empty data; existing samples are retained internally.

## Status legend

`live` real data path. `sample` served from seeded rows until the owning lane writes real ones (shape is final). `stub` returns `501 { error, code: 'not_implemented' }`; shape is final, behaviour lands with the lane.

## Endpoints

<!--ENDPOINTS:START-->
| Method | Path (under /api or /v1) | Request | Response | Status | Owner | Summary |
|---|---|---|---|---|---|---|
| GET | `/health` | - | `Health` | live | foundation | Liveness and binding check |
| GET | `/session` | - | `SessionInfo` | live | foundation | Current judge/app session, its workspace and caps |
| GET | `/workspaces` | - | `{ items: Entity[] }` | live | foundation | List sample workspaces |
| GET | `/workspaces/{id}` | params `id` | `Workspace` | live | foundation | Get a workspace |
| POST | `/workspaces/switch` | body `workspace_id` | `SessionInfo` | live | foundation | Bind this session to another sample workspace |
| GET | `/today` | - | `TodayFeed` | sample | foundation | Today feed: matches, closing soon, intakes, approvals, expiring certs |
| GET | `/tenders` | query `limit`, `cursor`, `q`, `country`, `status`, `min_fit` | `TenderList` | sample | sources | Matched tenders for the workspace |
| GET | `/tenders/{id}` | params `id` | `TenderDetail` | sample | sources | Tender with documents, latest run, verdicts |
| POST | `/tenders/{id}/runs` | params `id`; body `replay` | `StartRunResult` | live | engine | Start a pack run (read, extract, verdict). `replay` plays the showcase run |
| GET | `/tenders/{id}/matrix` | params `id` | `Matrix` | live | engine | Requirement matrix with statuses and evidence links |
| GET | `/tenders/{id}/verdicts` | params `id` | `{ items: Entity[] }` | live | engine | Per-lot bid / no-bid verdicts |
| GET | `/tenders/{id}/answers` | params `id` | `{ items: Entity[] }` | live | engine | Drafted answers with claim checks |
| POST | `/tenders/{id}/answers/draft` | params `id`; body `lot`, `question_ref`, `question`, `word_limit` | `Answer` | live | engine | Draft one answer from evidence (claim-checked) |
| PATCH | `/tenders/{id}/answers/{answerId}` | params `id`, `answerId`; body `draft`, `status` | `Answer` | live | engine | Edit or approve an answer |
| POST | `/tenders/{id}/forms/{docId}/fill` | params `id`, `docId`; body `answer_ids` | `FillFormResult` | live | engine | Fill the buyer's own DOCX form with approved answers |
| GET | `/tenders/{id}/forms/{docId}/filled` | params `id`, `docId` | (binary) | live | engine | Download the filled form (DOCX) |
| GET | `/runs/{id}` | params `id` | `RunDetail` | live | engine | Run with its steps |
| GET | `/runs/{id}/stream` | params `id` | (sse) | live | engine | SSE stream of run steps (event: step | done) |
| GET | `/buyers/{id}` | params `id` | `BuyerIntel` | live | engine | Buyer intelligence by buyer_key |
| POST | `/buyers/{id}/refresh` | params `id` | `RefreshBuyerResult` | live | engine | Refresh buyer intel with a live Tavily search (capped per session) |
| GET | `/evidence` | query `limit`, `cursor` | `{ items: Entity[] }` | sample | pack | Evidence library |
| GET | `/evidence/{id}` | params `id` | `Evidence` | sample | pack | One evidence item |
| POST | `/evidence` | - | (multipart) | live | pack | Upload evidence (multipart: file, title, kind, valid_to) |
| GET | `/intakes` | query `limit`, `cursor`, `door`, `status` | `{ items: Entity[] }` | live | connectors | Inbox of intakes (all three doors) |
| GET | `/intakes/{id}` | params `id` | `IntakeDetail` | live | connectors | One intake with documents |
| POST | `/intakes` | body `title`, `sender`, `text`, `door` | `IntakeCreateResult` | live | connectors | Create an intake by upload (multipart) or pasted text (JSON) |
| GET | `/design-requests` | - | `{ items: Entity[] }` | sample | quote | Design requests from customers |
| GET | `/design-requests/{id}` | params `id` | `DesignRequest` | sample | quote | Design request with requirements and product matches |
| POST | `/design-requests/{id}/match` | params `id` | `DesignRequest` | live | quote | Extract requirements and match against the product catalogue |
| POST | `/design-requests/{id}/quote` | params `id`; body `product_ids`, `qty`, `buyer_country`, `b2b`, `vat_registered` | `Quote` | live | quote | Create a priced quote from the matches |
| GET | `/products` | - | `{ items: Entity[] }` | sample | quote | Product catalogue |
| GET | `/quotes` | - | `{ items: Entity[] }` | sample | quote | Quotes |
| GET | `/quotes/{id}` | params `id` | `Quote` | sample | quote | One quote |
| GET | `/quotes/{id}/export` | params `id`; query `format` | (binary) | live | quote | Export quote as DOCX or XLSX |
| GET | `/connectors` | - | `{ items: Entity[] }` | live | connectors | Connector catalogue with live status |
| POST | `/connectors/{id}/connect` | params `id`; body `redirect_to` | `ConnectResult` | live | connectors | Start OAuth; returns the redirect URL (id = provider) |
| POST | `/connectors/{id}/disconnect` | params `id` | `{ ok }` | live | connectors | Disconnect a provider |
| POST | `/connectors/{id}/test` | params `id`; body `action`, `input` | `TestActionResult` | live | connectors | Run a test action on a connected provider |
| PATCH | `/connectors/{id}/rules` | params `id`; body `rules` | `ConnectorRulesResult` | live | connectors | Choose which events trigger which actions on a connector (id = provider) |
| GET | `/webhooks` | - | `{ items: Entity[] }` | live | foundation | Outbound webhook endpoints |
| POST | `/webhooks` | body `url`, `events` | `WebhookCreateResult` | live | foundation | Create endpoint; secret is returned once |
| DELETE | `/webhooks/{id}` | params `id` | `{ ok }` | live | foundation | Delete endpoint |
| GET | `/webhooks/{id}/deliveries` | params `id` | `{ items: Entity[] }` | live | foundation | Delivery log |
| GET | `/api-keys` | - | `{ items: Entity[] }` | live | foundation | API keys (prefix only) |
| POST | `/api-keys` | body `name` | `ApiKeyCreateResult` | live | foundation | Create key; full key shown once |
| DELETE | `/api-keys/{id}` | params `id` | `{ ok }` | live | foundation | Revoke key |
| GET | `/ics` | - | `IcsInfo` | live | foundation | Calendar feed URL (deadlines of matched tenders), served at /ics/{token}.ics |
| GET | `/agent/threads` | - | `{ items: Entity[] }` | live | agent | Agent chat threads |
| POST | `/agent/threads` | - | `AgentThread` | live | agent | New thread |
| GET | `/agent/threads/{id}/messages` | params `id` | `{ items: Entity[] }` | live | agent | Messages in a thread |
| POST | `/agent/threads/{id}/messages` | params `id`; body `content` | `AgentMessage` | live | agent | Send a message (HTTP fallback; prefer the WebSocket) |
| POST | `/agent/actions/{id}/confirm` | params `id` | `PendingAction` | live | agent | Approve a pending agent action |
| POST | `/agent/actions/{id}/decline` | params `id` | `PendingAction` | live | agent | Decline a pending agent action |
| POST | `/agent/messages` | body `content`, `thread_id` | `AgentTurnResult` | live | agent | Send a chat message without a WebSocket; runs the whole turn and returns it |
| POST | `/agent/actions/{id}` | params `id`; body `decision` | `PendingAction` | live | agent | Confirm or decline a pending agent action ({ decision }) |
| GET | `/agent/events` | - | (sse) | live | agent | SSE of the agent's proactive messages (event: message), for outbound subscribers such as the self-host desk agent |
| POST | `/agent/digest` | - | `AgentDigestResult` | live | agent | Post the morning digest now |
| GET | `/agent/ws` | - | (ws) | live | agent | WebSocket upgrade to the AgentHub Durable Object (frames: AgentWsMessage) |
| GET | `/billing` | - | `BillingState` | sample | billing | Plan and credit balance |
| POST | `/billing/checkout` | body `plan` | `UrlResult` | stub | billing | Dodo checkout URL |
| POST | `/billing/portal` | - | `UrlResult` | stub | billing | Dodo customer portal URL |
| GET | `/limits` | - | `Limits` | live | foundation | Real caps and usage for this session |
| GET | `/events` | query `since`, `limit` | `{ items: Entity[] }` | live | foundation | Recent events |
| GET | `/events/stream` | - | (sse) | live | foundation | SSE stream of workspace events (event: <type>) |
| POST | `/ingest/audit` | body `audit_id`, `status`, `job_id`, `result` | `{ ok }` | stub | audit | Nebius audit job posts its result (x-ingest-secret header) |
| GET | `/audits/{id}` | params `id` | `Audit` | stub | audit | Audit result |
<!--ENDPOINTS:END-->

Outside the typed registry:

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/openapi.json` | OpenAPI 3.1 generated from the registry (`x-pactovio-status`, `x-pactovio-lane` per operation) |
| GET | `/ics/{token}.ics` | Public calendar feed of matched tender deadlines; URL from `GET /api/ics` |
| GET (upgrade) | `/api/agent/ws` | WebSocket to the workspace `AgentHub` Durable Object. Frames: `AgentWsMessage` (`user_message`, `assistant_delta`, `assistant_message`, `approval_requested`, `event`, `error`). Today it sends `event agent.connected`, relays events, and answers messages with `error not_implemented` |
| POST | `/webhooks/composio`, `/webhooks/dodo` | Inbound third-party callbacks, 501 until the connectors and billing lanes |
| ALL | `/mcp` | MCP streamable HTTP, 501 until the agent lane |
| GET | `/dev/` | Plain-HTML index of GET endpoints (lanes may add bare test pages under `apps/api/src/dev/`) |

SSE streams (`text/event-stream`): `GET /runs/{id}/stream` emits `event: step` (data `RunStep`), then `event: done` (data `Run`); `GET /events/stream` emits `event: <EventType>` (data `PactovioEvent`) after replaying the last 10. Both close after 25 s with `event: reconnect`; reconnect to continue.

## Events

`tender.matched`, `intake.received`, `intake.classified`, `run.started`, `run.step`, `run.completed`, `verdict.ready`, `answer.drafted`, `approval.requested`, `audit.completed`, `quote.ready`, `certificate.expiring`, `billing.updated`. Emitted with `emit(env, workspaceId, type, payload)` from `@pactovio/events`: writes `events`, enqueues on `EVENTS`, notifies the AgentHub. Outbound webhooks carry `X-Pactovio-Signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">`.

## Cross-lane function stubs (replace bodies, keep signatures)

| Package | Functions |
|---|---|
| `@pactovio/pack` | `extractPack(env, { tenderId \| intakeId, r2Keys }) -> PackText` |
| `@pactovio/sources` | `searchTed(params)`, `fetchEtendersPack(resourceId)`, `runNightlyScan(env)` |
| `@pactovio/engine` | `startPackRun`, `draftAnswers`, `claimCheck`, `buyerIntel`, `fillForm` |
| `@pactovio/quote` | `matchDesignRequest`, `priceQuote` (pure), `createQuote` |
| `@pactovio/connectors` | `classifyEmail`, `connectUrl`, `runAction` |
| `@pactovio/billing` | `getPlan`, `checkoutUrl`, `chargeCredits` |
| `@pactovio/agent` | `agentTools: AgentTool[]` (shared by AgentHub chat and MCP) |
| `@pactovio/models` | `chat`, `chatJSON(schema, ...)`, `embed`, `rankByCosine`, `toolLoop`, limiters, `costUsd` (prices are estimates) |
| `@pactovio/events` | `emit`, `deriveWebhookSecret`, `signWebhook`, `verifyWebhook` |

Migrations: foundation `0001`; lanes use `0010-0079` in the ranges from the build brief. Seed data: `apps/api/scripts/seed-*.ts` (idempotent upserts keyed by id; `npm run seed:local` / `seed:remote`).
