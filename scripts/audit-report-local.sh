#!/usr/bin/env bash
# Print a one-line-per-claim view of a local audit row. Usage: audit-report-local.sh <audit_id> [state_dir]
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
bash cf.sh d1 execute pactovio --local --persist-to "${2:-.wrangler/state-H-nemo}" --json --command "SELECT status, result_json FROM audits WHERE id='$1'" |
python3 -c "
import sys,json
row=json.load(sys.stdin)[0]['results'][0]; print('status', row['status'])
d=json.loads(row['result_json'] or '{}')
print(json.dumps(d.get('summary')), json.dumps({k:d['red_team'][k] for k in ('total','caught','rate')} if d.get('red_team') else None))
for a in d.get('answers',[]):
  for c in a['claims']:
    print(a['question_ref'], c['verdict'], 'ours=',c.get('ours_claim_audit',{}).get('supported'), 'nemo_sc=',c.get('nemo_self_check_facts'), '|', c['text'][:60])
for p in (d.get('red_team') or {}).get('prompts',[]): print(p)
"
