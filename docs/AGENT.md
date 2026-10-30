# Pactovio agent: chat protocol, MCP and proactive events

The 24x7 agent lives in the `AgentHub` Durable Object (one per workspace, SQLite storage, WebSocket hibernation, alarms). Chat turns run a streaming tool loop on `MODEL_AGENT` (Nemotron 3.5 Super VL, thinking off) with a fallback to `MODEL_REASON` (Nemotron 3 Ultra) after two failed tool-calling attempts. NemoClaw, OpenShell and Hermes are not the runtime: they need Docker or an always-on host. Hermes runs as the optional Mac self-host desk agent and talks to this one over MCP and SSE.

Three rules are in the system prompt and enforced in code: cite or flag (every statement comes from a tool result), no arithmetic by the model (counts, dates and money are formatted by code), human approval (state-changing tools never execute from the model's call).

## Isolation

- Chat threads are private to the judge session (`pv_s`). Sessions of the same sample workspace share one AgentHub, so the **inbox** (`thr_inbox`, proactive messages) is workspace-wide and chats are not.
- A pending action created in a chat can only be decided by that session. Actions from events, the digest and MCP are workspace-wide.
- Caps per session: 10 agent turns per minute (`429 rate_limited` with the retry time in the message) and a token budget of 150,000 (`429 budget_exhausted`). Both are in `GET /api/limits` as `agent_turns_per_min_cap`.

## WebSocket: `GET /api/agent/ws`

Cookie session (`pv_s`) as every `/api` call. Frames are JSON and typed by `AgentWsMessage` in `@pactovio/contracts` (`createClient(...).parseAgentFrame`). On connect the server sends `event` with `event_type: "agent.connected"` and `payload.inbox_thread = "thr_inbox"`.

**Client to server**

| Frame | Fields | Effect |
|---|---|---|
| `user_message` | `content`, `thread_id?` | Runs a turn. Without `thread_id` a new thread is created (the server answers with a `thread` frame). |
| `action_decision` | `action_id`, `decision: "confirm" \| "decline"` | Decides a pending action card. |
| `ping` | | Server answers `event` with `event_type: "pong"`. |

**Server to client** (the brief's names in brackets)

| Frame | Fields | Meaning |
|---|---|---|
| `thread` | `thread` | The thread this turn runs in (new or existing). |
| `assistant_delta` | `thread_id`, `delta` | Token stream [token stream]. Concatenate until `assistant_message`. |
| `tool_call` | `thread_id`, `call_id`, `name`, `input`, `status`, `output?` | A tool started (`running`) and finished (`ok`, `error`, or `pending_confirmation`). Show as a chip. |
| `approval_requested` | `action`, `thread_id?` | [action_request] A confirmation card. `action` = `{ id, tool, input, title, detail, summary, status: "pending", source }`. Buttons call `action_decision`, or `POST /api/agent/actions/{id}`. |
| `action_result` | `action`, `message?` | [action_result] The action was decided. `action.status` is `executed` (with `result`), `declined` or `failed`; `message` is the assistant line to show. |
| `assistant_message` | `message` | The final assistant message of a turn, or a proactive message. `message.pending_action` is set when it carries a card. |
| `event` | `event_type`, `payload` | Raw domain event relay (every event, including ones that make no message). |
| `done` | `thread_id` | The turn is finished; re-enable the input. |
| `error` | `error`, `code?` | `rate_limited`, `budget_exhausted`, `not_found`, `validation`, `model_error`. |

Order of one turn that needs approval: `thread`, `assistant_delta`..., `tool_call running`, `approval_requested`, `tool_call pending_confirmation`, `assistant_message`, `done`. Streaming frames are scoped to the sending session; proactive frames (`assistant_message` in `thr_inbox`, `approval_requested`, `event`) go to every socket of the workspace.

## HTTP (no WebSocket)

| Call | Body | Returns |
|---|---|---|
| `GET /api/agent/threads` | | Inbox first, then this session's chats. |
| `POST /api/agent/threads` | | New empty thread. |
| `GET /api/agent/threads/{id}/messages` | | Messages; a card message carries `pending_action`. `thr_inbox` is readable by all sessions. |
| `POST /api/agent/messages` | `{ content, thread_id? }` | Runs the whole turn and returns `{ thread_id, messages, pending_actions }`. Streams on the session's sockets too. |
| `POST /api/agent/threads/{id}/messages` | `{ content }` | Same, returns the assistant `AgentMessage`. |
| `POST /api/agent/actions/{id}` | `{ decision: "confirm" \| "decline" }` | `PendingAction`. `409 conflict` if already decided (double clicks are safe: a tool runs exactly once). |
| `POST /api/agent/actions/{id}/confirm` and `/decline` | | Same, one verb each. |
| `POST /api/agent/digest` | | Posts the morning digest now (button: "Run digest"). |
| `GET /api/agent/events` | `?since=<message id>` or `Last-Event-ID` | SSE of proactive messages, `event: message`, `data: { workspace_id, event_type, message }`. Closes after 5 minutes with `event: reconnect`; keepalive comments every 15 s. For outbound subscribers such as the Mac desk agent (use `/v1/agent/events` with an API key). |

Everything is also under `/v1` with `Authorization: Bearer pk_...`.

## Tools (shared by chat and MCP)

`list_today`, `search_tenders`, `get_tender`, `start_pack_run`, `get_matrix`, `get_verdicts`, `draft_answers`, `approve_answer`, `buyer_intel`, `list_intakes`, `create_design_request_from_text`, `match_design_request`, `create_quote`, `list_connectors`, `run_connector_action`, `billing_status`, `get_limits`.

Confirmation required (the tool returns a pending action and does nothing until a human confirms): `start_pack_run`, `draft_answers`, `approve_answer`, `create_design_request_from_text`, `match_design_request`, `create_quote`, `run_connector_action`, and `buyer_intel` when `refresh: true` (live Tavily call). Read tools run immediately and return compact JSON (at most 30 matrix rows, gaps first). A tool whose owning lane is not built yet returns `{ error, code: "not_available_yet" }` as data.

## Proactive messages

`packages/events` notifies the hub for every event; the hub turns these into inbox messages (deduplicated by event id), each with an action card where it makes sense:

| Event | Message | Card |
|---|---|---|
| `tender.matched` | "New match: <title>, fit 86. ... Read the pack?" | `start_pack_run` |
| `intake.classified` | RFQ/RFP or design request from email, "Start spec match?" / "Start the pack read?" | `match_design_request` / `start_pack_run` |
| `verdict.ready` | "Verdict ready for <title>, lot 1: BID (score 78)." | `draft_answers` (BID, CONDITIONAL) |
| `approval.requested` | "An answer needs your approval: Q2.5.1 ..." | `approve_answer` (shows the draft) |
| `audit.completed`, `certificate.expiring`, `quote.ready`, `run.completed` | One informational line | none |

Alarm (daily, 06:30 MYT = 22:30 UTC, armed by any contact and by the nightly cron through `ensureAgentAlarms`): the morning digest (numbers from `list_today`, wording from code, a card to read the best new match), deadline reminders at 7, 2 and 1 days, and certificate nudges at 60, 30 and 7 days and when expired. Each reminder fires once.

**Mirror to Slack/Teams.** When a workspace has a connected, non-sample `slack`, `teams` or `microsoftteams` connector, each proactive message is also posted with `connectors.runAction(env, ws, provider, "post_message", { text, channel? })`. Cards carry signed approve and decline links: `GET /api/agent/actions/{id}/link?w=&d=confirm|decline&t=` shows a confirm button (link previews cannot decide), the button POSTs the same URL. The token is an HMAC of workspace, action and decision under `WEBHOOK_SIGNING_SECRET`.

## MCP: `POST /mcp`

Streamable HTTP, JSON responses, stateless. `Authorization: Bearer pk_...` (create a key with `POST /api/api-keys`); `401` with `WWW-Authenticate: Bearer` otherwise. Methods: `initialize` (negotiates `2025-06-18`, `2025-03-26`, `2024-11-05`), `notifications/*` (202), `ping`, `tools/list` (the 17 tools with JSON Schema and `readOnlyHint`), `tools/call`. `tools/call` on a confirmation tool returns `{ status: "pending_confirmation", action_id, title, detail }` and the card appears in the workspace chat and Slack; tool failures are `isError: true` results, protocol errors are JSON-RPC errors. GET and DELETE are `405`.

```bash
curl -s localhost:8787/mcp -H "authorization: Bearer $PK" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_tenders","arguments":{"q":"Web applications"}}}'
```

## Local development

`POST /api/agent/dev-emit { type, payload }` emits a domain event as the session's workspace (404 unless `ENVIRONMENT=development`); use it to see proactive messages without running the whole pipeline. Wrangler reloads the Worker (and drops open sockets) whenever any file in the repo changes.
