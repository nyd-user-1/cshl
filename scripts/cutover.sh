#!/usr/bin/env bash
#
# Point cshl.nysgpt.com's PRODUCTION at the CSHL preprint database — or put it back.
#
#   scripts/cutover.sh            # flip production DATABASE_URL -> CSHL, redeploy prod
#   scripts/cutover.sh --rollback # flip it back to whatever NSR value is in the backup, redeploy
#   scripts/cutover.sh --dry-run  # print what would happen, touch nothing
#
# NOT run by finish-load.sh and not run by anything automatic. Brendan reserved this
# action by name; it executes only when a human runs this file.
#
# Rollback in one sentence, for the addendum and for a groggy morning: this changes ONE
# Vercel environment variable and redeploys. `CSHL_DATABASE_URL[_UNPOOLED]` stay staged
# untouched, and the previous production value is saved to .cutover-backup before any
# change, so `scripts/cutover.sh --rollback` puts the site back exactly as it was.
set -euo pipefail
cd "$(dirname "$0")/.."
SCOPE="--scope nys-gpt"
MODE="${1:-flip}"
BACKUP=".cutover-backup"

set -a; . ./.env.local; set +a
EXPECT="ep-orange-water-aut2eymf"
CSHL_URL="${DATABASE_URL:?}"
case "$(printf '%s' "$CSHL_URL" | sed -E 's#^[^@]+@([^/?]+).*#\1#')" in
  "$EXPECT"*) : ;;
  *) echo "FENCE FAIL: .env.local DATABASE_URL is not the CSHL endpoint — refusing." >&2; exit 1 ;;
esac

if [ "$MODE" = "--rollback" ]; then
  [ -s "$BACKUP" ] || { echo "no $BACKUP — cannot roll back automatically." >&2; exit 1; }
  echo "Restoring the previous production DATABASE_URL from $BACKUP …"
  vercel env rm DATABASE_URL production --yes $SCOPE >/dev/null 2>&1 || true
  tr -d '\n' < "$BACKUP" | vercel env add DATABASE_URL production --sensitive --force $SCOPE >/dev/null
  vercel deploy --prod --yes $SCOPE
  echo "Rolled back. cshl.nysgpt.com is serving the previous database again."
  exit 0
fi

# The rollback value CANNOT be read back from Vercel: production variables are stored
# sensitive and `vercel env pull` returns the literal string "[SENSITIVE]" with no error
# — the trap recorded in LANE-RXIV-MAP.md. So .cutover-backup is written ahead of time
# from the value that was transferred into this project, and this script refuses to flip
# unless that file holds a real, non-CSHL postgres URL. A cutover without a proven
# rollback is not a cutover, it is a one-way door.
if ! grep -qE '^postgres(ql)?://' "$BACKUP" 2>/dev/null; then
  echo "REFUSING: $BACKUP does not hold a usable rollback URL." >&2
  echo "  (production vars are sensitive; the value cannot be recovered from Vercel afterwards)" >&2
  exit 1
fi
if grep -q "$EXPECT" "$BACKUP"; then
  echo "REFUSING: $BACKUP already points at the CSHL endpoint — that is not a rollback target." >&2
  exit 1
fi
echo "  rollback target verified: $(sed -E 's#^[^@]+@##; s#/.*##' "$BACKUP")"

if [ "$MODE" = "--dry-run" ]; then
  echo "DRY RUN — would set production DATABASE_URL to the CSHL endpoint ($EXPECT) and redeploy."
  exit 0
fi

echo "Setting production DATABASE_URL -> CSHL …"
vercel env rm DATABASE_URL production --yes $SCOPE >/dev/null 2>&1 || true
printf '%s' "$CSHL_URL" | vercel env add DATABASE_URL production --sensitive --force $SCOPE >/dev/null
echo "Redeploying production …"
vercel deploy --prod --yes $SCOPE
echo
echo "LIVE. cshl.nysgpt.com now serves the CSHL preprint corpus."
echo "Undo with: scripts/cutover.sh --rollback"
