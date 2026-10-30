#!/bin/sh
# Canonical process of the sandbox: optional Slack gateway in the background, event bridge in the foreground.
set -u
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ]; then
  /opt/hermes/bin/hermes -p pactovio gateway run >> /sandbox/state/gateway.log 2>&1 &
fi
exec python3 /opt/pactovio/bridge.py
