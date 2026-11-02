# PAC-010 backend integration contract

This checkpoint changes `/api` to customer authentication. An anonymous `pv_s` cookie never authenticates `/app` requests. Existing sample data is retained but cannot be selected through customer sessions or sample API keys. The frontend must provide the email-code entry flow and route unauthenticated `/api/session` responses to it.

## Browser requests

Use same-origin `fetch` with `credentials: 'same-origin'` (or the browser default). Send JSON with `Content-Type: application/json`. The browser must send `Origin` on every mutation, including request-code, verify, logout, multipart upload and WebSocket opening. It must match `PUBLIC_ORIGIN`, or the request URL origin when that variable is absent. Foreign/missing origins return 403 `origin_forbidden`. Do not put session tokens in localStorage or frontend state.

| Request | Input | Success |
| --- | --- | --- |
| `POST /api/auth/code/request` | `{email}` | 202 `{ok:true,retry_after:60,expires_in:600}` |
| `POST /api/auth/code/verify` | `{email,code}`; code is a six-digit string, preserving leading zeros | 200 current `SessionInfo`, plus HttpOnly customer cookie |
| `POST /api/auth/logout` | `{}` or empty body | 200 `{ok:true}`; revokes current session and expires cookie |
| `GET /api/session` | none | 200 `SessionInfo`; 401 `unauthorized` when signed out/expired/revoked |
| `GET /api/onboarding` | none | 200 `OnboardingInfo` |
| `PATCH /api/onboarding` | `{company?: Partial<CompanyInput>, settings?: Partial<CustomerSettings>}` | 200 saved `OnboardingInfo` |
| `POST /api/onboarding/complete` | `{}` | 200 `OnboardingInfo`; requires all required company fields |

`SessionInfo` keeps the existing fields `session_id`, `workspace_id`, `workspace`, `caps`, `runs_used`, `tavily_used`, and adds `authenticated:true`, `user:{id,email}`, `onboarding_complete:boolean`. The session ID is an identifier, never an authentication credential. `workspace.sample` is always false for customers. Customer cookie `pv_customer` is opaque, expires in 30 days and uses HttpOnly, Secure and SameSite=Lax (Secure is relaxed only for HTTP development). A subsequent successful login rotates/revokes the previous browser session when that cookie is present. Logout revokes that browser session; independent signed-in devices remain signed in.

`OnboardingInfo` is `{company,settings,completed_at:string|null,updated_at:string}`. A new company/settings object is empty, with `completed_at:null`. Partial saves are resumable; completion is idempotent. Both company and settings reject unknown input fields, including workspace IDs.

`CompanyInput` fields:

- `name`: trimmed string, 2–160 characters.
- `website`: optional empty string or HTTP(S) URL, at most 2048 characters.
- `country`: ISO-style two-letter country code, normalized uppercase.
- `supplier_segment`: `it` or `industrial`.
- `capabilities`: 1–50 nonempty trimmed strings, at most 160 characters each.

`CustomerSettings`: optional `timezone` (valid IANA timezone, e.g. `Asia/Kuala_Lumpur`) and `notifications_enabled` boolean. This checkpoint persists preferences; it does not add new notification channels. A company save updates the existing workspace profile fields consumed by the engine. No evidence, catalogue, references, certifications, staff count or financial facts are invented.

All errors are `{error:string,code?:string}`. Request-code returns the same success body for a new and existing email. Input errors are 400 `validation`; wrong, expired, used or attempt-locked codes are 400 `invalid_code`; throttling is 429 `rate_limited`; missing sender/HMAC setup is 503 `auth_unavailable`; delivery failure is 503 `delivery_unavailable`. Never interpret request-code success as proof of an existing account. Show a resend countdown from `retry_after`; show a recoverable retry error for 503. No code is returned by the API or written to logs.

## Connections and private data

Existing `/api/connectors` endpoints and response shapes remain. `POST /api/connectors/{provider}/connect {redirect_to?}` requires a customer browser session and returns `{redirect_url}`. Navigate the browser to it. `redirect_to` accepts `/app#/onboarding`; every other value becomes `/app#/connections`. `/v1` API keys can list/test/disconnect/edit rules for their private workspace; initiating browser OAuth with only an API key returns 403.

Configure the Composio project verifier as `https://YOUR_ORIGIN/api/connectors/verifier`. Composio returns `session_uri`; Pactovio combines it with its HttpOnly ten-minute `pv_oauth` cookie and the still-valid starting customer session. The server redeems the URI, checks the returned account/toolkit, fetches the account, verifies ACTIVE status, user and provider, and atomically consumes its own hashed OAuth state. Query-string workspace/provider IDs confer no authority. `/api/connectors/callback` also remains for the existing callback transport; production verification requires a `session_uri`.

The result is a 302 to `/app#/connections?connector=PROVIDER&status=success|failed` (or the same suffix on `/app#/onboarding`). Parse these parameters inside the URL fragment. Missing/invalid state redirects to `/app#/connections?status=failed`; a missing/expired customer session returns 401. A failed/replayed callback cannot adopt an account. A new attempt supersedes older attempts for that provider. An unavailable trigger is not represented as a fabricated connection; mailbox registration uses the existing real `watch_inbox` implementation.

Real workspaces use stable `pactovio-workspace-WORKSPACE_ID` Composio users and never the demo user. Sync can refresh only previously verified owned accounts, including shared Outlook/calendar siblings. Existing demo synchronization remains internal sample behavior. Disconnect and rules operate on the authenticated workspace. The frontend must use returned live catalogue status for badges.

Workspace listing returns the current private workspace only. `/workspaces/switch` accepts only that current ID; attempts to choose samples or other companies return 403. Foreign workspaces, evidence, intakes, runs, quotes, private uploaded tenders, documents and files return 404. Public procurement notices and public tender documents remain public-domain records, accessible to authenticated customers by ID. Pack/model operations refuse tenders containing another workspace's private attachments because shared engine readers are keyed by tender. Agent tool calls and confirmation descriptions receive the same boundary checks. Quotas remain 2 fresh runs, 3 buyer refreshes and 10 agent turns/minute; compatibility counters in `judge_sessions` are not authentication. The global inference spend cap and kill switch are unchanged.

## Configuration and migration (coordinator actions)

No existing/live database was migrated and no real email/provider request was made by this worker. Before enabling this checkpoint, the coordinator must:

1. Apply the additive `apps/api/migrations/0080_customer_auth.sql` through the established D1 migration process on the chosen target. Do not seed customer workspaces. Existing samples and legacy counters remain.
2. Supply a cryptographically random `AUTH_SECRET` of at least 32 characters, `RESEND_API_KEY`, and `AUTH_EMAIL_FROM` using an already verified Resend sending domain. These values are environment bindings; do not commit them. Changing AUTH_SECRET invalidates outstanding email codes, not stored sessions.
3. Set `PUBLIC_ORIGIN` to the exact browser origin. Set production `ENVIRONMENT=production`.
4. Keep Composio credentials/project webhook signing secret isolated to Pactovio. Configure the project callback verifier URL above, then set `COMPOSIO_CALLBACK_VERIFIER_ENABLED=true`. Until then customer connect returns 409 `needs_setup` in production. The worker did not modify provider authentication or auth configs.
5. Verify live Resend delivery and customer OAuth/trigger routing using authorized customer accounts, then integrate/review the frontend. Native Durable Object/WebSocket and real-provider behavior require the coordinator's runtime verification.

Official implementation references: [D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Hono cookies](https://hono.dev/docs/helpers/cookie), [Resend send API](https://resend.com/docs/api-reference/emails/send-email), [Composio callback identity verification](https://docs.composio.dev/reference/v3/api-reference/connected-accounts), [complete_auth](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth).

## Verification and integration dependencies

Run `npm run typecheck`. Run normal `npm test` where workerd may bind loopback ports. In this restricted worker, the normal harness failed before tests with `listen EPERM`; `PACTOVIO_TEST_SQLITE=1 npm test` uses a real in-memory SQLite adapter and in-memory KV/R2 storage, with fake provider transports only. It does not emulate Workflows or Durable Objects; business/store unit tests and route binding tests remain available.

Two existing tests outside this worker's owned paths still assume anonymous sample authentication and need coordinator fixture updates: `packages/quote/test/routes.test.ts` (sample switch in beforeAll) and `packages/sources/test/today.test.ts` (anonymous `/api/today`). Reuse `apps/api/test/customer-fixture.ts` with their seeded workspace before authenticated route calls and send `Origin` for mutations. Their product source was not changed. No frontend file was edited or browser/UI verification performed by this backend worker.

Final local validation: `npm run typecheck` passed; `PACTOVIO_TEST_SQLITE=1 npm test -- apps/api/test packages/contracts/test packages/connectors/test packages/models/test` passed all 280 tests in 24 files. The complete storage-adapter run had 454 passing tests, 7 skipped tests, and the two out-of-scope legacy-auth failures described above (44 files total, 42 passed). `git diff --check` passed. No live deployment/provider/browser test is claimed.

## Customer catalogue and evidence

`GET /api/products` lists the authenticated workspace catalogue. `POST /api/products` and `PUT /api/products/{id}` accept `{sku,name,family?,unit?,unit_price_minor,currency}` and return the saved Product. Unknown fields and foreign IDs are rejected; SKU uniqueness is per workspace. Amounts use integer minor units. The supported two-decimal currencies are USD, EUR, GBP, MYR, INR, AUD, CAD, SGD, CHF, CNY, HKD, NZD, AED, SAR, ZAR, SEK, NOK, DKK, PLN, CZK, THB, ILS, BRL, MXN, PHP and TRY. Other currency formats are rejected rather than mispriced.

Evidence accepts exactly one nonempty PDF, DOCX, PNG, JPG, WebP or TXT file up to12MB through authenticated multipart `POST /api/evidence`. Optional fields are title (max200), kind and a real YYYY-MM-DD valid_to. The browser supplies the multipart boundary. Choose datasheet for product specifications. A ready response means the actual read/indexing path finished; limits and provider failures remain recoverable errors. New customers are never told to run sample seeds.

Scheduled scans select completed private customer workspaces, excluding retained demo data and incomplete onboarding. Customer catalogue currency supplies the initial quote currency when no explicit currency rule exists. Without configured tax rules, customer quotes exclude tax and require supplier confirmation; they do not inherit the sample company's tax or delivery commitments.

## Integration discovery

Authenticated `GET /api/integrations/catalog` discovers the current nondeprecated native Composio toolkit catalogue through the project's API key. It follows every page before returning a complete snapshot, caches metadata for15minutes and supports `search`, `category`, `offset` and `limit` (1–100). Unknown query fields are rejected. Metadata discovery never reads connected customer accounts or executes toolkit actions.

The response includes `items`, filtered `total`, `catalog_total`, `categories`, `retrieved_at` and `next_offset`. Items have a toolkit slug/name/description/logo, categories, authentication schemes and `setup` (`managed_auth`, `own_credentials` or `no_auth`). A non-null `connection_provider` identifies an existing Pactovio connector; its actual account/status must still come from `/api/connectors`. A null value means discovery only. Every item's `catalog_import:false` is intentional: a catalogue listing or connected account does not claim an implemented inbound product importer. Provider failures return a recoverable503 `integration_unavailable`, without partial success or provider diagnostics.
