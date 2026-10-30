#!/usr/bin/env bash
# Start the Pactovio NeMo audit job on Nebius Serverless Jobs (CLI only; no Worker ever calls the control plane).
#   scripts/start-audit-job.sh            start pactovio-audit-<timestamp> (reads the queue at $APP_URL)
#   scripts/start-audit-job.sh --spike    start pactovio-spike-<timestamp>: proves start -> run -> exit, no secrets, no network calls
#   scripts/start-audit-job.sh --delete   delete FINISHED jobs named pactovio-audit-* / pactovio-spike-*
#   scripts/start-audit-job.sh --status <job_id>   print state only
# DRY_RUN=1 validates the create request without creating anything.
# Secrets: NEBIUS_API_KEY and INGEST_SECRET come from the environment, else from ENV_FILES (default
# apps/api/.env.local and apps/api/.dev.vars). Values are never printed. APP_URL defaults to https://pactovio.pages.dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="hackathon-jobs-sa"
NB=(nebius --profile "$PROFILE")
PLATFORM="cpu-d3"; PRESET="2vcpu-8gb"       # cheapest CPU preset in eu-west2
IMAGE="python:3.12-slim"
mode="run"; target=""
case "${1:-}" in
  --spike) mode="spike" ;;
  --delete) mode="delete" ;;
  --status) mode="status"; target="${2:?job id}" ;;
  "") ;;
  *) echo "usage: $0 [--spike|--delete|--status <id>]" >&2; exit 2 ;;
esac

jobs_json() { "${NB[@]}" ai job list --format json; }
state_of() { "${NB[@]}" ai job get "$1" --format json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status",{}).get("state","UNKNOWN"))'; }

if [ "$mode" = "status" ]; then state_of "$target"; exit 0; fi

if [ "$mode" = "delete" ]; then
  jobs_json | python3 -c '
import sys,json
d=json.load(sys.stdin)
for j in d.get("items",[]):
    n=j.get("metadata",{}).get("name","")
    s=j.get("status",{}).get("state","")
    if n.startswith(("pactovio-audit-","pactovio-spike-")) and s in ("COMPLETED","SUCCEEDED","FAILED","CANCELLED","ERROR","STOPPED"):
        print(j["metadata"]["id"], n, s)
' | while read -r id name state; do
    echo "deleting $name ($id, $state)"; "${NB[@]}" ai job delete "$id" >/dev/null
  done
  exit 0
fi

ts="$(date -u +%Y%m%d-%H%M%S)"
if [ "$mode" = "spike" ]; then
  name="pactovio-spike-$ts"
  CMD='python -c "import platform,sys,time; print(\"pactovio spike ok\", platform.python_version(), time.strftime(\"%H:%M:%S\")); sys.exit(0)"'
  args=(--name "$name" --image "$IMAGE" --platform "$PLATFORM" --preset "$PRESET" --disk-size 30Gi --timeout 1h
        --container-command bash --args "-c '$CMD'")
else
  name="pactovio-audit-$ts"
  for f in ${ENV_FILES:-$ROOT/apps/api/.env.local $ROOT/apps/api/.dev.vars}; do
    [ -f "$f" ] && { set -a; source "$f"; set +a; }
  done
  : "${NEBIUS_API_KEY:?NEBIUS_API_KEY not set}"; : "${INGEST_SECRET:?INGEST_SECRET not set}"
  APP_URL="${APP_URL:-https://pactovio.pages.dev}"
  # Ship the job as one base64 env var (config + python, ~10 KB): no registry, no image build.
  bundle="$(cd "$ROOT/jobs/audit" && tar czf - audit.py claims.py ours_actions.py redteam.py config | base64 | tr -d '\n')"
  RUN='set -e; pip install -q --no-cache-dir nemoguardrails==0.24.1 pyyaml; mkdir -p /app; echo "$AUDIT_BUNDLE_B64" | base64 -d | tar xz -C /app; cd /app; python audit.py'
  args=(--name "$name" --image "$IMAGE" --platform "$PLATFORM" --preset "$PRESET" --disk-size 30Gi --timeout 1h
        --container-command bash --args "-c '$RUN'"
        --env "NEBIUS_API_KEY=$NEBIUS_API_KEY" --env "INGEST_SECRET=$INGEST_SECRET" --env "APP_URL=$APP_URL"
        --env "AUDIT_BUNDLE_B64=$bundle")
fi

if [ "${DRY_RUN:-0}" = "1" ]; then "${NB[@]}" ai job create "${args[@]}" --dry-run; exit $?; fi
out="$("${NB[@]}" ai job create "${args[@]}" --async --format json)"
id="$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("resource_id") or d.get("metadata",{}).get("id",""))')"
echo "job_name=$name"
echo "job_id=$id"
