#!/usr/bin/env bash
# Operator script: LoRA fine-tune of an NVIDIA Nemotron model for Pactovio's tender-notice extraction, in ONE Nebius AI Cloud Serverless GPU job
# (1x H100, eu-north1). The job pulls EU TED notices itself (public API, no key), builds/dedupes/splits the dataset, evaluates the base model
# zero-shot, trains a LoRA adapter, evaluates the tuned model on the same held-out test set, and prints one line `FINETUNE_REPORT {json}`.
# Usage: scripts/start-finetune.sh    then:  nebius --profile hackathon-jobs-sa ai job logs --id <id>   (and `ai job delete --id <id>` when finished)
# Env overrides: BASE_MODEL, EPOCHS, TED_PAGES, DRY_RUN=1 (validate only). No secrets are needed or passed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; F="$ROOT/jobs/finetune"
PROJECT="${NEBIUS_GPU_PROJECT:-project-e00fwfe5pr00k4s8jdngz0}"   # eu-north1: the H100 quota lives here
D=/opt/pactovio/finetune
FILES=(--inject-file "$F/run.sh:$D/run.sh" --inject-file "$F/build_dataset.py:$D/build_dataset.py" --inject-file "$F/train_eval.py:$D/train_eval.py")
ENVS=()
for v in BASE_MODEL EPOCHS TED_PAGES; do [ -n "${!v:-}" ] && ENVS+=(--env "$v=${!v}"); done
DRY=(); [ -n "${DRY_RUN:-}" ] && DRY=(--dry-run)
OUT="$(nebius --profile hackathon-jobs-sa ai job create --parent-id "$PROJECT" --name "pactovio-finetune-$(date +%m%d-%H%M)" --image pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime \
  --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 100Gi --timeout 50m "${FILES[@]}" ${ENVS[@]+"${ENVS[@]}"} \
  --container-command bash --args $D/run.sh --async ${DRY[@]+"${DRY[@]}"} --format json)"
[ -n "${DRY_RUN:-}" ] && { echo "dry run ok"; exit 0; }
JOB_ID="$(printf '%s' "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['resource_id'])")"
echo "started $JOB_ID"
