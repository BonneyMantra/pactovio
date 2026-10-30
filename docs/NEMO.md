# NeMo Guardrails audit (lane H)

Every drafted bid answer is audited before approval. The audit runs as a **Nebius Serverless Job** (`python:3.12-slim`, CPU `cpu-d3` / `2vcpu-8gb`, eu-west2), started from the CLI only, and posts its result back to the app. No Worker calls the Nebius control plane.

## What is NeMo and what is ours

| Layer | Label in `result_json` | Who wrote it |
|---|---|---|
| Regex output rail `regex check output` | `nemo_regex_output_rail` | NeMo Guardrails 0.24.1 library rail. Our patterns (`jobs/audit/config/config.yml`) flag five claim types: certifications, SLAs, headcounts, client names, money. |
| `claim_audit` | `ours_claim_audit` | Our custom NeMo action (`jobs/audit/ours_actions.py`, `claims.py`), wired by our Colang flow `claim audit` (`config/rails.co`). Every concrete value in a flagged claim (ISO 27001, 64 staff, EUR 9.8M) must appear in that answer's evidence. |
| `self check facts` | `nemo_self_check_facts` | NeMo Guardrails library rail. Judge model: Nemotron 3.5 Super VL on Token Factory (OpenAI-compatible, `https://api.tokenfactory.nebius.com/v1/`), the answer's evidence as `relevant_chunks`, `max_tokens` set explicitly (400 model, 200 task prompt), thinking off. |

A claim is `supported` only if our check **and** NeMo's self check agree; `no_claim_flagged` sentences are not judged. Claims where the two disagree (NeMo's LLM says yes, our value check says no) are the interesting ones and are kept visible in the result.

NeMo 0.24 runs every configured output flow in one pass, so `audit.py` builds one `LLMRails` per rail to attribute each verdict.

## Red team

`jobs/audit/redteam.py`: 10 prompts (fabricated certificate, inflated headcount, invented SLA, invented client, inflated turnover, wrong certificate number, prompt injection inside the answer, authority spoof, uncited price commitment, mixed true and false) against a fixed evidence set. The result is `red_team: { total, caught, rate, prompts[] }` inside the audit result and is mirrored to KV key `audit:red_team:latest` for `/limits`. Local run: 10/10 caught by both our check and NeMo's self check.

## Flow

1. The engine inserts an `audits` row (`status='queued'`, `subject_type='tender'` with the tender id, or `'answer'` with one answer id).
2. `scripts/start-audit-job.sh` creates `pactovio-audit-<timestamp>` with `NEBIUS_API_KEY`, `INGEST_SECRET`, `APP_URL` and the job bundle (base64 tarball, about 14 KB) as env.
3. The job `pip install nemoguardrails==0.24.1 pyyaml`, `GET /api/ingest/audit/queue?claim=1&job_id=...` (header `X-Ingest-Secret`), audits each answer, then `POST /api/ingest/audit`, which updates the row to `completed`/`failed` and emits `audit.completed`.

## Commands

```bash
scripts/start-audit-job.sh            # full job against $APP_URL (default https://pactovio.pages.dev)
scripts/start-audit-job.sh --spike    # start -> run -> exit proof, no secrets
scripts/start-audit-job.sh --delete   # delete finished pactovio-audit-* / pactovio-spike-* jobs
DRY_RUN=1 scripts/start-audit-job.sh  # validate the create request only
scripts/run-audit-local.sh            # same script on this Mac against wrangler dev (PORT=8797)
```

Measured: spike job create to COMPLETED about 3 min 15 s (provisioning 1 min, starting 1.5 min, image pull 20 s). The full job adds a pip install (about 1 min) and about 1 s per live self-check call.
