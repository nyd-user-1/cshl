#!/usr/bin/env bash
# Final load: stage bioRxiv details + both pubs files, upsert, derive, reindex.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "=== $(date +%H:%M:%S) staging bioRxiv details ==="
CHUNK=25000 node scripts/load-rxiv.mjs details data/rxiv/details-biorxiv.ndjson
echo "=== $(date +%H:%M:%S) upsert (sql/04) ==="
scripts/psql-cshl.sh -f sql/04-upsert.sql
echo "=== $(date +%H:%M:%S) staging pubs ==="
CHUNK=25000 node scripts/load-rxiv.mjs pubs
echo "=== $(date +%H:%M:%S) derive (sql/05) ==="
scripts/psql-cshl.sh -f sql/05-derive.sql
echo "=== $(date +%H:%M:%S) create anything missing (sql/02) ==="
scripts/psql-cshl.sh -f sql/02-preprints-indexes.sql
echo "=== $(date +%H:%M:%S) REAL index rebuild + analyze (sql/07) ==="
scripts/psql-cshl.sh -f sql/07-reindex.sql
echo "=== $(date +%H:%M:%S) embeddings sidecar, table only (sql/08) ==="
scripts/psql-cshl.sh -f sql/08-embeddings.sql
echo "=== $(date +%H:%M:%S) key assertion, independent of the loader ==="
node scripts/assert-keys.mjs || echo "*** KEY ASSERTION FAILED ***"
echo "=== $(date +%H:%M:%S) DONE ==="
