#!/bin/sh
# Create (or refresh) the OpenShell providers and the 'pactovio' sandbox, then run the bridge as its main process.
# Usage: bin/up.sh [--recreate (rebuild image + sandbox) | --restart (restart bridge after a key rotation)]
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
[ -f .env.local ] || { echo "missing .env.local: run bin/inject.sh first" >&2; exit 1; }
set -a; . ./.env.local; set +a
: "${NEBIUS_API_KEY:?run bin/inject.sh}"
: "${PACTOVIO_APP_URL:=http://host.openshell.internal:8798}"
: "${PACTOVIO_API_KEY:=pk_placeholder_until_lane_f_keys_exist}"
export PACTOVIO_APP_URL PACTOVIO_API_KEY

brew services list 2>/dev/null | grep -q '^openshell .*started' || brew services start nvidia/openshell/openshell >/dev/null
i=0; until openshell status >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 40 ] && { echo "openshell gateway not reachable" >&2; exit 1; }; sleep 3; done

docker image inspect pactovio-desk:0.1 >/dev/null 2>&1 || docker build -t pactovio-desk:0.1 "$DIR"

openshell profile list 2>/dev/null | grep -q nebius-tokenfactory || openshell provider profile import -f profiles/nebius-tokenfactory.yaml
openshell profile list 2>/dev/null | grep -q pactovio-api || openshell provider profile import -f profiles/pactovio-api.yaml
if openshell provider list | grep -q '^pactovio-nebius'; then openshell provider update pactovio-nebius --credential NEBIUS_API_KEY >/dev/null
else openshell provider create --name pactovio-nebius --type nebius-tokenfactory --credential NEBIUS_API_KEY >/dev/null; fi
if openshell provider list | grep -q '^pactovio-api'; then openshell provider update pactovio-api --credential PACTOVIO_API_KEY >/dev/null
else openshell provider create --name pactovio-api --type pactovio-api --credential PACTOVIO_API_KEY >/dev/null; fi

# Slack tokens (optional, arrive later): stored as an OpenShell provider, never as sandbox env or command-line text.
SLACK_PROVIDER=""; POLICY=policy.yaml
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_APP_TOKEN:-}" ]; then
  openshell profile list 2>/dev/null | grep -q pactovio-slack || openshell provider profile import -f profiles/pactovio-slack.yaml
  if openshell provider list | grep -q '^pactovio-slack'; then openshell provider update pactovio-slack --credential SLACK_BOT_TOKEN --credential SLACK_APP_TOKEN >/dev/null
  else openshell provider create --name pactovio-slack --type pactovio-slack --credential SLACK_BOT_TOKEN --credential SLACK_APP_TOKEN >/dev/null; fi
  SLACK_PROVIDER="--provider pactovio-slack"
  # Bind the Slack credentials to the Slack endpoints only (a binding to an unattached provider would be rejected).
  mkdir -p .state
  python3 - <<'PY'
import re
s = open("policy.yaml").read()
s = re.sub(r"(enforcement: enforce)( \})", r"\1, credential_binding: { provider: pactovio-slack }\2", s)
open(".state/policy.yaml", "w").write(s)
PY
  POLICY=.state/policy.yaml
fi

if [ "${1:-}" = "--restart" ]; then  # pick up rotated provider credentials: replace the bridge process
  openshell sandbox exec -n pactovio -- pkill -f /opt/pactovio/bridge.py || true; exit 0
fi
if [ "${1:-}" = "--recreate" ]; then docker build -q -t pactovio-desk:0.1 "$DIR" >/dev/null; fi
if [ "${1:-}" = "--recreate" ]; then openshell sandbox delete pactovio >/dev/null 2>&1 || true; fi
if openshell sandbox get pactovio >/dev/null 2>&1; then echo "sandbox 'pactovio' already exists (use --recreate to rebuild)"; exit 0; fi
# Non-secret config goes in as sandbox env; secrets arrive only as OpenShell placeholders through the providers.
openshell sandbox create --name pactovio --from pactovio-desk:0.1 --policy "$POLICY" \
  --provider pactovio-nebius --provider pactovio-api --detach --restart-policy always \
  $SLACK_PROVIDER -- env "PACTOVIO_APP_URL=$PACTOVIO_APP_URL" "SLACK_ALLOWED_USERS=${SLACK_ALLOWED_USERS:-}" \
     "SLACK_HOME_CHANNEL=${SLACK_HOME_CHANNEL:-}" /opt/pactovio/entrypoint.sh
