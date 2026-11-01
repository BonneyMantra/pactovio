# PAC-010 integration foundation

This folder contains reviewed **structural** Composio schemas and provider HTTP test fixtures.
It is not a frontend package or an unrestricted Composio executor. The implementation lives in
`apps/api/src/lib/integration-*.ts` and `apps/api/src/routes/integration-workflows.ts`.

The coordinator must mount `integrationWorkflowRoutes` at `/api/integrations/workflows`.
The existing `/api/integrations/catalog` and connector actions are unchanged.
Apply `0081_integrations.sql` only through the coordinator's separately authorized migration process.
This worker applied it only to disposable test databases through the existing `makeEnv` harness.

## Actual capability limits

The complete native catalogue remains metadata-driven. Every toolkit can expose real detail,
authentication schemes, counts of required auth fields, and paginated operation metadata.
Credentials, defaults, auth-config IDs, project tokens and raw authentication schemas are omitted.
Operation names and `readOnlyHint` are discovery information, never execution authority.

Hosted connection initiation supports existing enabled project configs for OAuth1, OAuth2,
API key, Basic and Bearer schemes that the native toolkit actually advertises. Managed OAuth
must also appear in that toolkit's managed-scheme list. No auth configs are created or changed.
Missing configs, unsupported schemes and an unverified project callback gate return `needs_setup`.
Non-OAuth configs with prefilled credentials, and configs with shared connection credentials,
are excluded: customer accounts must never inherit a project/demo credential.
API-key/Basic/Bearer entry happens in Composio's hosted page; Pactovio accepts no raw credentials.
No live customer connection is established or claimed by these tests.

There are 18 explicit read definitions based on the project's 1 November 2026 native-tool export:

| Toolkit | Bound operation | Availability in this checkpoint |
| --- | --- | --- |
| Zoho Inventory | `ZOHO_INVENTORY_LIST_ITEMS` | Schema-bound read and mapping |
| Zoho Books | `ZOHO_BOOKS_LIST_ITEMS` | Needs verification: upstream organization ID regex is double escaped |
| Shopify | `SHOPIFY_GET_PRODUCTS_PAGINATED` | Product variants; currency can remain unresolved |
| Square | `SQUARE_SEARCH_CATALOG_OBJECTS` | ITEM variations; integer minor-unit prices |
| Stripe | `STRIPE_LIST_PRODUCTS` | Product metadata; default price is only an ID, so price stays unresolved |
| QuickBooks | `QUICKBOOKS_QUERY_ITEMS` | Fixed SELECT of Item, bounded pages |
| Xero | `XERO_LIST_ITEMS` | Explicit selected tenant; currency can remain unresolved |
| HubSpot | `HUBSPOT_LIST_PRODUCTS` | Complete selected catalogue with paginated product reads |
| Salesforce | `SALESFORCE_RUN_SOQL_QUERY` | Fixed PricebookEntry SELECT for a selected price book |
| Pipedrive | `PIPEDRIVE_GET_ALL_PRODUCTS` | Product/price records; user maps the chosen price entry |
| Google Sheets | `GOOGLESHEETS_VALUES_GET` | Explicit bounded spreadsheet range; positional columns |
| Google Drive | `GOOGLEDRIVE_GET_SPREADSHEET_VALUES` | Selected spreadsheet range only, not document ingestion |
| Excel | `EXCEL_LIST_TABLE_ROWS` | Explicit drive/workbook/table; positional columns |
| Airtable | `AIRTABLE_LIST_RECORDS` | Explicit base/table |
| Notion | `NOTION_QUERY_DATABASE` | Selected database; explicit property mapping |
| NetSuite | `NETSUITE_RUN_SUITEQL_QUERY` | Fixed item ID/SKU/name query; no invented price |
| ERPNext | `ERPNEXT_GET_ITEM_DETAILS` | Explicit item/company/selling price list/currency/conversion rate |
| SharePoint | `SHARE_POINT_GET_LIST_ITEMS` | Selected site/list; explicit field mapping |

Seventeen definitions are enabled; every enabled definition has a fake HTTP response checked
against its recorded output schema and exercised through persisted staging. This proves local
protocol behavior, not live provider/customer compatibility. Salesforce orgs without
CurrencyIsoCode, provider permission differences, source API changes and provider errors can
still prevent reads and return explicit recoverable failures. Scope/identity verification is
repeated before each read and approval. Inputs, outputs, scopes, tags, toolkit and exact tool
version must match the reviewed definition before execution. Unknown tools cannot execute.

Odoo has no invented product adapter. Dropbox selected-file import is not implemented.
Document import advertises its three missing phases: selected-file retrieval, extraction and
indexing. No model, embedding, extraction, source-write, messaging or automatic-sync path was added.
Other catalogue toolkits remain discovery-only for imports until a reviewed binding is added.
The validated tabular-record fallback uses the same preview/approval/provenance protocol.

## Source of schemas and references

`src/reviewed-tools.json` contains structural schemas, operation names, versions, scopes and tags
from the coordinator's secret-free live project export. Descriptions, examples, defaults,
credential values and the private export itself are excluded. Structural schema drift fails
closed. The deliberately small JSON-schema validator rejects unsupported assertion keywords;
it is not a general-purpose arbitrary-schema execution engine.

Official API references consulted:

- https://docs.composio.dev/reference/api-reference/toolkits/getToolkitsBySlug
- https://docs.composio.dev/reference/api-reference/tools/getTools
- https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug
- https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs
- https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink
- https://docs.composio.dev/docs/tools-direct/authenticating-tools
- https://docs.composio.dev/docs/auth-configuration/connected-accounts
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://hono.dev/docs/api/hono

## Coordinator API contract

All routes below are relative to `/api/integrations/workflows`. They require a real customer
session. Mutations require the exact Origin and JSON content type; bodies are capped at 256000
bytes. Queries and bodies are strict. Errors are `{error,code?}` with sanitized messages.
Mutation requests are bounded at 120 per workspace/hour; model budgets and the kill switch are unchanged.

| Request | Input / result |
| --- | --- |
| GET `/toolkits/:slug` | Real auth requirements, connection setup state, version-bound import metadata, document limitations |
| GET `/toolkits/:slug/operations?cursor=...` | 100 metadata-only operations/page; next cursor |
| GET `/connections` | Local IDs/status checkpoints; these are not live remote-status claims |
| POST `/toolkits/:slug/connect` | `{return_path?: '/app#/onboarding' or '/app#/connections'}` -> `{connection_id,redirect_url,expires_in}` |
| GET `/verifier` | Composio callback, state cookie, current customer session; redirects with toolkit/status |
| POST `/connections/:id/disconnect` | `{}`; invalidate local access, verify and remove only locally bound remote accounts; retry `disconnect_pending` |
| POST `/imports/select` | `{connection_id,adapter,resource}` -> persisted job; source account/workspace are server derived |
| POST `/imports/tabular` | `{resource,external_id_field,rows}`; 1–100 scalar-record rows with unique external IDs |
| GET `/imports` | Latest 50 private jobs |
| GET `/imports/:id` | Actual state/revision/staged/applied/exhausted counts, checkpoint error, current preview |
| GET `/imports/:id/rows?offset=0` | 50 staged rows with source IDs/versions/retrieval times and scalar fields |
| POST `/imports/:id/read` or `/resume` | `{revision}`; one actual source page, persisted cursor, recoverable 60-second lease |
| POST `/imports/:id/preview` | `{revision,mapping,selected_ids,resolutions?}` -> frozen current preview/revision/hash |
| POST `/imports/:id/approve` | `{revision,preview_hash,idempotency_key}` -> immutable receipt with actual writes from that preview |

Resource schemas come from `catalog_import.selection_schema` in toolkit detail. The only
account ID accepted from a client is a local connection ID, never a remote account or user ID.
At most500 unapproved records are staged at once. Approving batches frees capacity, and Resume retains the source cursor so larger catalogues can continue without restarting. Use pending=true on the rows endpoint for selectable pending records; omit it for audit history.
A read/preview/approval revision conflict requires reloading job state. `read_failed` preserves
actual rows and the last successful cursor. Resume retries only the uncommitted page. Completed
retrieval pages are not replayed. Partial source batches with errors are not misreported as success.

Mapping fields are `external_id`, `sku`, `name`, `price`, `price_format: 'decimal'|'minor'`,
and exactly one of `currency` (source field) or `confirmed_currency` (explicit user assertion).
Optional `unit` selects a source field. Use `_source_id` for `external_id`: it is the adapter's
actual record/variant identity, or source row position for tabular Sheets/Excel reads.
Sheets/Excel fields are `column_1`, `column_2`, etc.; headers are not guessed. Row-position
identity is scoped to the selected resource/range and is not a provider's immutable business ID.
Nested provider fields use explicit dot paths such as `properties.name` or `prices.0.price`.
No unit conversion, price-book choice or currency inference is performed implicitly.

`resolutions` is an optional list of `{external_id,product: Partial<ProductInput>}` for explicit
customer corrections. Missing/invalid required fields stay unresolved until corrected. No zero
price, fabricated SKU/name or currency is supplied. Exact decimal strings reject excess precision,
scientific notation, separators, negative values and overflow; supported currencies match ProductInput.

Only unapplied rows selected in the frozen preview can be approved. An unresolved row blocks
that approval; users can approve another selection and return to remaining rows. An exhausted
source with all staged rows applied becomes `completed`; otherwise the job stays `partial`.
The immutable receipt, frozen preview and source provenance preserve mapping, resolutions,
source toolkit/account/resource/external ID/version/retrieval time and target product revision.

Imported products can be updated only through their original source binding, and only when the
product revision still matches its last imported revision. Database triggers detect manual edits,
including changes and reversions. Existing manual SKUs, other source bindings, duplicate preview
SKUs and another tenant's data cannot be overwritten. All writes and preconditions share one
D1 batch. One target conflict rolls back every row. Replaying the same idempotency key and
preview returns the same receipt; changing its hash/revision returns `preview_conflict`.

## Callback integration and setup dependencies

The dedicated return URL is `/api/integrations/workflows/verifier?state=...`. Set the project's
actual callback verifier before enabling `COMPOSIO_CALLBACK_VERIFIER_ENABLED=true`.
The coordinator can dispatch the existing `/api/connectors/verifier` to exported
`integrationVerifier(c)` when `pv_integration_oauth` is present; preserve the old verifier path
and its gate for existing connectors. Managed/custom OAuth must redeem `session_uri`; hosted
non-OAuth must return the explicit state. The cookie is HttpOnly, SameSite=Lax, scoped `/api`.
State is hashed, session/workspace/toolkit/account/origin-bound, expires in ten minutes and has
one conditional winner. Old/replayed/mismatched callbacks cannot replace newer attempts.
Superseded callback failures preserve the newer cookie and do not consume its state.
A disconnect also invalidates pending callbacks and removes owned attempt accounts after remote
identity verification. In-flight initiation remains explicitly cleanup-pending; a late-created account is removed without revoking a newer attempt. A failed remote cleanup remains explicitly retryable, never a fake success.

Do not treat the environment flag alone as proof that provider project setup was performed.
The worker did not access credentials, configure providers, migrate live storage or deploy.
Live setup, migration, route mounting, callback dispatch, frontend integration and real customer
verification remain the coordinator's responsibility. Existing known connectors were not changed.

## Local verification and handback limits

The coordinator-focused suite has 69 passing tests across six `integration-workflows*.test.ts` files,
using the existing `makeEnv`/customer fixture and real disposable SQLite transactions. Only
provider HTTP transports are mocked. The 100-row boundary, mixed-row transaction rollback,
manual edits, tenant/session/account/toolkit forgery, missing Origin, OAuth expiry/replay and
supersession, malformed/partial source results, durable pagination, interrupted leases,
source revocation, preview revisions, exact money and idempotent approvals are covered.
Own test environments retain USD0.25/day and the model kill switch ON; no models are invoked.

`npm run typecheck` passes. The full repository run also exposed two out-of-scope suites:
`engine-replay.test.ts` has two 20-second replay timeouts; the frontend evidence fixture cannot
start because this sandbox rejects localhost listeners with EPERM. These files were not edited.
The regression run excluding those two suites passes; the worker handoff records the final count.
No browser/UI rendering was attempted by this backend worker.

Tests used `PACTOVIO_TEST_SQLITE=1` with a temporary Vitest config matching the repository test
settings and redirecting Vite's cache to a writable temporary directory. The worktree uses a
read-only dependency symlink; standard Vite config bundling otherwise tries to write into the
coordinator's node_modules directory and is blocked. No package/dependency files were changed.

Existing known-connector accounts are not automatically adopted into this separate connection
table. No global/demo account search or account-copy endpoint exists. If a provider refuses a
second active account for an existing auth config, the coordinator must reconcile that owned
connection lifecycle before claiming a seamless existing-connector import. Native link creation
errors remain recoverable failures, not fabricated connected states. The coordinator retains
ownership of connector/callback reconciliation and the single risk review.
