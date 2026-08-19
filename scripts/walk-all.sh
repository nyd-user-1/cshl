#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
export CONC=${CONC:-16}
for job in "details medrxiv" "details biorxiv" "pubs biorxiv" "pubs medrxiv"; do
  echo "=== START $job  $(date +%H:%M:%S) ==="
  node scripts/walk-rxiv.mjs $job || echo "=== $job EXITED NONZERO ==="
  echo "=== END   $job  $(date +%H:%M:%S) ==="
done
echo "=== ALL WALKS COMPLETE $(date +%H:%M:%S) ==="
