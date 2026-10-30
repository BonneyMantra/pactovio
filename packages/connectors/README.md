# @pactovio/connectors (lane D)

15 enterprise connectors through Composio (REST v3.1, managed OAuth), plus live email intake. Agent-facing; terse.

| Where | What |
|---|---|
| `src/catalog.ts` | the 15 providers, what Pactovio does with each, default event rules |
| `src/providers/*.ts` | per-provider actions (`run`, `readback`, `cleanup`, `sample`); every tool call is validated against the live Composio input schema in `test/actions.test.ts` |
| `src/accounts.ts` | connect (Connect Link) / callback / sync of connections made elsewhere / disconnect / catalogue |
| `src/events.ts` | `runEventActions(env, event)`: called by the EVENTS queue consumer; runs each connected connector's enabled rules |
| `src/webhook.ts`, `src/signature.ts` | `POST /webhooks/composio`: signature check, dedupe, open intake, start `IntakeWorkflow` |
| `src/intake.ts`, `src/classify.ts`, `src/inbound-mail.ts` | fetch message + attachments, Lightning classify, route (design request / tender + pack run), reply DRAFT |
| `../../scripts/connector-e2e.ts` | live end-to-end per connected provider (action, readback, cleanup) and the email round trip |

## Rules

- Composio user id: `connectors.meta_json.composio_user_id`, default `pactovio-demo` (both sample workspaces share it).
- Per-workspace rules live in `meta_json.rules` (`PATCH /api/connectors/{provider}/rules`), merged over `DEFAULT_RULES` by event + action. Chat (Slack, Teams) defaults to off here because the AgentHub already mirrors proactive messages with signed approve/decline links.
- Event payload fields read: `verdict.ready {tender_id}`, `run.completed {tender_id | subject_type=tender + subject_id, status}`, `quote.ready {quote_id, r2_key?}`, `answer.drafted {filled_form_r2_key? | r2_key?}`, `intake.classified {intake_id, door, title, sender, tender_id, design_request_id}` (emitted by this lane). Everything else is loaded from D1.
- External objects are idempotent per subject: KV `cx:xref:*` maps tender / requirement / quote to the created deal, task, event or estimate; queue retries are deduped by event id.
- Pactovio never sends mail. Replies are drafts. `send_test_message` only sends from the mailbox to itself.

## Connect steps and what each needs

See `scripts/connector-e2e.ts` (`CONNECT_STEPS`). Managed OAuth for 13 of 15; DocuSign and Xero need our own OAuth app (`scripts/connector-setup.ts`); Teams needs a Microsoft 365 work account.
