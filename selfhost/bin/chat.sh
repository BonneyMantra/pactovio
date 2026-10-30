#!/bin/sh
# One Hermes turn inside the sandbox: bin/chat.sh "your question"
APP="$(grep '^PACTOVIO_APP_URL=' "$(dirname "$0")/../.env.local" | cut -d= -f2-)"
exec openshell sandbox exec -n pactovio -- env "PACTOVIO_APP_URL=${APP:-http://host.openshell.internal:8798}" \
  /opt/hermes/bin/hermes -p pactovio chat -Q -q "${1:?question}" --max-turns "${MAX_TURNS:-6}"
