#!/usr/bin/env bash
# Run jobs/audit/audit.py on this Mac against a local wrangler dev (default :8797). Secrets are sourced, never echoed.
# Needs a venv with nemoguardrails==0.24.1 (VENV=...), apps/api/.env.local (NEBIUS_API_KEY) and .dev.vars (INGEST_SECRET).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${VENV:-$ROOT/jobs/audit/.venv}"
if [ ! -x "$VENV/bin/python" ]; then python3 -m venv "$VENV" && "$VENV/bin/pip" install -q nemoguardrails==0.24.1 pyyaml; fi
set -a; source "$ROOT/apps/api/.env.local"; source "$ROOT/apps/api/.dev.vars"; set +a
export APP_URL="${APP_URL:-http://localhost:${PORT:-8797}}"
exec "$VENV/bin/python" "$ROOT/jobs/audit/audit.py"
