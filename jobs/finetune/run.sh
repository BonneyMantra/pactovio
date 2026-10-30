#!/usr/bin/env bash
# Entrypoint of the Pactovio fine-tune job on Nebius AI Cloud (1x H100, pytorch CUDA image). Files are injected under /opt/pactovio/finetune.
set -euo pipefail
export HF_HOME=/tmp/hf PYTHONUNBUFFERED=1 TOKENIZERS_PARALLELISM=false
pip install --no-cache-dir -q "transformers==4.51.3" "peft==0.15.2" "accelerate==1.6.0" "huggingface_hub<1.0"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
mkdir -p /tmp/data
python3 -u /opt/pactovio/finetune/build_dataset.py /tmp/data "${TED_PAGES:-10}" 2>&1 | tail -n 5
exec python3 -u /opt/pactovio/finetune/train_eval.py /tmp/data
