#!/usr/bin/env bash
# Guarded psql for the CSHL database. Refuses to run against any other endpoint.
# Usage: scripts/psql-cshl.sh [-f file.sql | -c "SQL" | ...]   (extra args pass through)
set -euo pipefail
EXPECT="ep-orange-water-aut2eymf"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; . "$ROOT/.env.local"; set +a
URL="${DATABASE_URL_UNPOOLED:?DATABASE_URL_UNPOOLED not set}"
HOST="$(printf '%s' "$URL" | sed -E 's#^[^@]+@([^/?]+).*#\1#')"
case "$HOST" in
  "$EXPECT".*) : ;;
  *) echo "FENCE FAIL: endpoint is '$HOST', expected '$EXPECT.*' — refusing to run." >&2; exit 1 ;;
esac
exec psql "$URL" -v ON_ERROR_STOP=1 "$@"
