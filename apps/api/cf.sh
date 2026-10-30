#!/usr/bin/env bash
# wrangler with Cloudflare credentials loaded from .env.local (never echoed).
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f .env.local ] && source .env.local; set +a
exec npx wrangler "$@"
