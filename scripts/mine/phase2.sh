#!/usr/bin/env bash
# scripts/mine/phase2.sh — the whole Phase-2 harvest + assembly, in order.
#
#   scripts/mine/phase2.sh                     # harvest + assemble, eval stays a DRY RUN
#   scripts/mine/phase2.sh --freeze            # ... and stamp cshl-eval-v1 FROZEN
#
# Every step is resumable, so a rerun after any failure picks up where it
# stopped rather than re-spending. The order is load-bearing: the text sidecar
# has to exist before assembly, citations have to be resolved before triplets,
# and the freeze has to be last because it hydrates from everything above.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RUN="node --env-file=.env.local"
LOG="data/mine/raw/phase2.log"
mkdir -p data/mine/raw
step() { echo; echo "══ $* ══ $(date -u +%H:%M:%SZ)" | tee -a "$LOG"; }
timed() { local t0=$SECONDS; "$@" 2>&1 | tee -a "$LOG"; echo "   ($((SECONDS-t0))s)" | tee -a "$LOG"; }

# ── preflight ────────────────────────────────────────────────────────────────
# The fence lives in psql-cshl.sh and in lib.mjs; this just refuses to harvest
# against a corpus that is still loading, because a partial corpus silently
# produces a partial dataset that looks complete.
step "preflight"
ROWS=$(scripts/psql-cshl.sh -t -A -c "select count(*) from preprints")
BIO=$(scripts/psql-cshl.sh -t -A -c "select count(*) from preprints where server='biorxiv'")
MED=$(scripts/psql-cshl.sh -t -A -c "select count(*) from preprints where server='medrxiv'")
PUB=$(scripts/psql-cshl.sh -t -A -c "select count(*) from preprints where published_doi is not null")
echo "corpus: $ROWS papers (biorxiv $BIO · medrxiv $MED) · $PUB with a published DOI" | tee -a "$LOG"
MIN=${MIN_ROWS:-420000}
if [ "$ROWS" -lt "$MIN" ]; then
  echo "REFUSING: $ROWS < $MIN expected. The loader is not done — set MIN_ROWS to override." | tee -a "$LOG"
  exit 1
fi

# ── harvest ──────────────────────────────────────────────────────────────────
step "1/7 citations — OpenAlex source walk, both servers"
timed $RUN scripts/mine/citations.mjs --walk

step "2/7 citations — gap fill for corpus DOIs the source walk missed"
timed $RUN scripts/mine/citations.mjs --gapfill

step "3/7 citations — resolve references back to corpus keys"
timed $RUN scripts/mine/citations.mjs --resolve

step "4/7 MeSH — DOI→PMID→descriptors, both servers"
timed $RUN scripts/mine/mesh.mjs --run --page-lanes 6

# ── free query family (no model, no spend) ───────────────────────────────────
step "5/7 EXTRACT — corpus IDF, then keyphrase queries"
timed node scripts/mine/extract-queries.mjs --df
timed node scripts/mine/extract-queries.mjs --run

# ── assembly ─────────────────────────────────────────────────────────────────
step "6/7 assemble — text sidecar, triplets, classifiers, query pairs"
timed $RUN scripts/mine/assemble.mjs --text --triplets --classify --pairs

step "7/7 freeze + verify"
if [ "${1:-}" = "--freeze" ]; then
  timed $RUN scripts/mine/assemble.mjs --eval --verify --i-have-brendans-go
else
  echo "eval left as a DRY RUN — pass --freeze to stamp cshl-eval-v1 FROZEN" | tee -a "$LOG"
  timed $RUN scripts/mine/assemble.mjs --eval --verify
fi

step "done"
ls -la data/mine/*.jsonl data/mine/eval/*.jsonl | tee -a "$LOG"
