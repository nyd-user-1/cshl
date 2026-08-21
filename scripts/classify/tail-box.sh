#!/bin/bash
# Read the classify box's log via SSM. State, not activity: this reads the actual
# log the run is writing, so "quiet" and "stopped" are distinguishable.
set -euo pipefail
ID=${1:?usage: tail-box.sh <instance-id> [lines]}
N=${2:-40}
CID=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --parameters "commands=[\"tail -n $N /var/log/classify.log\"]" \
  --query 'Command.CommandId' --output text)
for i in $(seq 1 30); do
  s=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$ID" --query Status --output text 2>/dev/null || echo Pending)
  [ "$s" = InProgress ] || [ "$s" = Pending ] || break
  sleep 2
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$ID" --query StandardOutputContent --output text
