#!/usr/bin/env bash
# launch-until.sh — retry a launcher across a capacity ladder until ONE box exists.
#
# THE RIG DEFECT THIS EXISTS TO FIX (LANE-QP3, 2026-08-20T09:30Z).
#
# A retry loop asked "did the launch succeed?" by grepping the launcher's STDOUT
# for `^instance: i-`. `launch-prep.sh` prints that line. `launch.sh` does not —
# it ends with a bare `echo "$ID"`. So against launch.sh EVERY SUCCESSFUL LAUNCH
# READ AS A FAILURE, and the ladder fired again 90 s later. Four g6e training
# boxes, same 17,500-step run, all billing, ~$5.96/h against a $15 cap. The lead
# killed three.
#
# The launcher was fine. The loop was fine. The CONTRACT between them was
# assumed, and stdout is not a contract — it is prose that changes when someone
# improves a log line.
#
# THE RULE, general: a launcher's success signal is the OBSERVABLE EXISTENCE OF
# THE INSTANCE, not a string in its stdout. Ask EC2, not the script.
#
# Corollaries, all of them paid for tonight:
#   - Check for a pre-existing instance BEFORE the first attempt. A retry that
#     cannot see the box it already made will double-fire forever.
#   - Tag at launch and filter on the tag. `--tag-specifications` makes the
#     instance self-identifying the moment RunInstances returns.
#   - `pending` counts as success. A box mid-boot is a box you are paying for.
#
#   RUN_TAG='cshl-train-*' TYPE_MENU=... ./scripts/train/launch-until.sh ./scripts/train/launch.sh
set -uo pipefail
REGION=${REGION:-us-east-1}
RUN_TAG=${RUN_TAG:?set RUN_TAG (the Name tag pattern the launcher applies, e.g. cshl-train-*)}
TRIES=${TRIES:-60}
SLEEP=${SLEEP:-90}
LAUNCHER=${1:?usage: RUN_TAG=... ./launch-until.sh <launcher> [args]}
shift || true

live() {
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=$RUN_TAG" "Name=instance-state-name,Values=pending,running" \
    --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name,Tags[?Key==`Name`].Value|[0]]' \
    --output text 2>/dev/null
}

# BEFORE the first attempt, not only between attempts.
EXISTING=$(live)
if [ -n "$EXISTING" ]; then
  echo "REFUSING TO LAUNCH — an instance matching $RUN_TAG is already alive:"
  echo "$EXISTING"
  echo "If that box is not the one you want, terminate it explicitly first."
  exit 0
fi

for attempt in $(seq 1 "$TRIES"); do
  echo "attempt $attempt at $(date -u +%H:%M:%SZ): $LAUNCHER"
  "$LAUNCHER" "$@" 2>&1 | sed 's/^/  | /'
  sleep 15                       # let RunInstances become visible to the describe API
  FOUND=$(live)
  if [ -n "$FOUND" ]; then
    echo "SUCCESS — instance observed via describe-instances (not parsed from stdout):"
    echo "$FOUND"
    exit 0
  fi
  echo "attempt $attempt: no instance matching $RUN_TAG exists — retrying in ${SLEEP}s"
  sleep "$SLEEP"
done
echo "GAVE UP after $TRIES attempts — no instance matching $RUN_TAG could be created" >&2
exit 1
