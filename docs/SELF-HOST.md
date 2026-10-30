# Self-host desk agent (Mac)

Hermes Agent 0.15.1, profile `pactovio`, runs inside an NVIDIA OpenShell sandbox on Docker (colima). Model: Nemotron-3.5-Super-VL on Nebius Token Factory. Tools: Pactovio's MCP server. Proactive events arrive over an outbound SSE stream. Chat goes through Slack once tokens exist.

The hosted AgentHub Durable Object stays the always-on brain. The Mac agent is an optional desk agent on top of it.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| OpenShell gateway | macOS, `brew services` (`sh.brew.openshell`), `https://localhost:17670`, mTLS | Config `~/.config/openshell/gateway.toml`: Docker driver, colima socket, host network mode, `grpc_endpoint = https://host.docker.internal:17670` |
| Sandbox `pactovio` | colima Docker, image `pactovio-desk:0.1` (python 3.12, Hermes in `/opt/hermes`) | Restart policy `always` |
| Main process | `entrypoint.sh`: Slack gateway (only if tokens) plus `bridge.py` | Bridge logs to `/sandbox/state/bridge.log` |
| Hermes profile `pactovio` | inside the image, `/sandbox/.hermes/profiles/pactovio` | Config in `selfhost/hermes/` |
| Providers | OpenShell: `pactovio-nebius`, `pactovio-api`, optional `pactovio-slack` | Real keys stay in the gateway; the sandbox holds placeholders |

## Network policy (`selfhost/policy.yaml`)

Default deny. Allowed, for the Python interpreter and curl only:
`api.tokenfactory.nebius.com:443`, `pactovio.pages.dev:443`, `host.openshell.internal:8798` (local dev, testing), `slack.com`, `api.slack.com` plus `wss-primary.slack.com` and `wss-backup.slack.com` (Slack Socket Mode needs them).
Credentials are bound per endpoint: the Nebius key resolves only on Token Factory, the Pactovio key only on the two Pactovio hosts.
Denied probe, from `openshell logs pactovio`:
`NET:REFUSE [MED] DENIED github.com [reason:policy_dns_ineligible]` and `NET:OPEN [MED] DENIED /usr/bin/curl(0) -> github.com:443 [reason:transparent_tcp_policy_denied]` (same for example.com).

## Start, stop, remove

```
cd pactovio/selfhost
bin/inject.sh            # NEBIUS_API_KEY from the vault into .env.local (gitignored); prints names only
# edit .env.local: PACTOVIO_APP_URL (local: http://host.openshell.internal:8798, hosted: https://pactovio.pages.dev), PACTOVIO_API_KEY
bin/up.sh                # idempotent: gateway, image, providers, sandbox
bin/up.sh --restart      # after rotating a key or APP_URL: replaces the bridge process (needed: placeholders are per generation)
bin/up.sh --recreate     # rebuild image and sandbox
bin/chat.sh "question"   # one Hermes turn in the sandbox
bin/down.sh              # delete the sandbox and its providers (gateway left running)
```

Keys come from `POST /api/api-keys` (shown once). Changing APP_URL to the hosted URL needs a sandbox recreate, since it is passed as sandbox env.

launchd: render `selfhost/launchd/ai.pactovio.selfhost.plist.template` (command in its header) to `~/Library/LaunchAgents/ai.pactovio.selfhost.plist` and `launchctl bootstrap gui/$(id -u) ...`. It runs `up.sh` at login and every 10 minutes. It is NOT loaded by default. Unload: `launchctl bootout gui/$(id -u)/ai.pactovio.selfhost`.

Full removal: `bin/down.sh`; `docker rmi pactovio-desk:0.1`; `openshell provider profile delete nebius-tokenfactory pactovio-api pactovio-slack`; `brew services stop openshell && brew uninstall openshell`; `rm -rf ~/.config/openshell ~/.local/state/openshell`.

## The bridge

`bridge.py` opens `GET {APP_URL}/v1/agent/events` (SSE, API key) from inside the sandbox. Each inbox message is handed to `hermes -p pactovio chat -Q -q <prompt>`. The agent may read through the MCP tools, then summarises and asks the person to confirm or decline. It never confirms for them (state-changing tools only return `pending_confirmation`). The last event id is stored, so it resumes after a restart or sleep. No inbound port, no tunnel.

## When the Mac sleeps

The sandbox stops with the Mac. Nothing is lost: the hosted AgentHub keeps the proactive messages in its inbox and handles chat, alarms and the Slack/Teams posts itself. On wake the bridge reconnects with `Last-Event-ID` and replays what it missed.

## Slack gateway (prepared, tokens not yet supplied)

Needed in `selfhost/.env.local`: `SLACK_BOT_TOKEN` (xoxb-, scopes chat:write, channels:history, im:history, app_mentions:read), `SLACK_APP_TOKEN` (xapp-, connections:write, Socket Mode on), `SLACK_ALLOWED_USERS` (member ids), `SLACK_HOME_CHANNEL`. Then `bin/up.sh --recreate`: the tokens become the `pactovio-slack` provider with a binding to the Slack hosts, and the entrypoint starts `hermes gateway run`. Not tested live.

## Verified on 30 Oct

One Hermes turn through the sandbox hit Token Factory; `mcp test` and `tools/list` returned 17 tools from a local Pactovio dev server on :8798; a pending MCP action produced an SSE event that the bridge handed to Hermes, which replied asking for confirmation.
