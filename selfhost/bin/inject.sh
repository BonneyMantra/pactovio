#!/bin/sh
# Fetch NEBIUS_API_KEY from the vault into selfhost/.env.local (gitignored). Never prints the value.
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEEP=""
[ -f "$DIR/.env.local" ] && KEEP="$(grep -E '^(PACTOVIO_|SLACK_)' "$DIR/.env.local" || true)"
"$HOME/.claude/vault/inject.sh" get NEBIUS_API_KEY --dir "$DIR" >/dev/null
[ -n "$KEEP" ] && printf '%s\n' "$KEEP" >> "$DIR/.env.local"
cut -d= -f1 "$DIR/.env.local"
