#!/usr/bin/env bash
# Build .dev.vars from .env.local (names only are ever shown) and start wrangler dev on :$PORT (default 8787).
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env.local ]; then
  # Worker secrets only: Cloudflare deploy creds never go into the Worker.
  grep -vE '^(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)=' .env.local > .dev.vars || true
fi
grep -q '^INGEST_SECRET=' .dev.vars 2>/dev/null || echo "INGEST_SECRET=dev-ingest-secret" >> .dev.vars
grep -q '^ENVIRONMENT=' .dev.vars 2>/dev/null || echo "ENVIRONMENT=development" >> .dev.vars  # enables response-schema validation locally
set -a; [ -f .env.local ] && source .env.local; set +a
exec npx wrangler dev --port "${PORT:-8787}" "$@"
