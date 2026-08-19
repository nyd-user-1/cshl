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
# The floor must be the corpus's DECLARED size, not a round number below it.
# Set to 420000 on the first run, this guard passed at 426,352 — while medRxiv
# was still 7,097 rows short of its true 87,567 (an early upsert had read a
# partially-staged table). A guessed floor only catches a loader that has barely
# started; it cannot catch one that is nearly done, which is the case that
# actually produces a plausible-looking wrong dataset. Per-server counts, from
# the ingest lane's independently verified figures.
EXPECT_BIO=${EXPECT_BIORXIV:-345882}
EXPECT_MED=${EXPECT_MEDRXIV:-87567}
MIN=$((EXPECT_BIO + EXPECT_MED))
if [ "$BIO" -lt "$EXPECT_BIO" ] || [ "$MED" -lt "$EXPECT_MED" ]; then
  echo "REFUSING: biorxiv $BIO/$EXPECT_BIO · medrxiv $MED/$EXPECT_MED (total $ROWS/$MIN)." | tee -a "$LOG"
  echo "  A per-server shortfall is invisible in the total — that is why this checks both." | tee -a "$LOG"
  echo "  Override with EXPECT_BIORXIV= / EXPECT_MEDRXIV= only if the ingest lane has re-declared them." | tee -a "$LOG"
  exit 1
fi
echo "preflight OK: biorxiv $BIO/$EXPECT_BIO · medrxiv $MED/$EXPECT_MED" | tee -a "$LOG"

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
step "5/7 assemble — the text sidecar FIRST (everything below reads it)"
# Ordering is load-bearing and was wrong on the first full run: EXTRACT reads
# corpus-text.jsonl, so the sidecar has to be rebuilt for the current corpus
# BEFORE the keyphrase pass, not after. It only looked right during Phase 1
# because the sidecar happened to already exist at the right size — a step order
# that works only when nothing has changed is a coincidence, not an order.
timed $RUN scripts/mine/assemble.mjs --text

step "6/7 EXTRACT — corpus IDF, then keyphrase queries (reads the sidecar above)"
timed node scripts/mine/extract-queries.mjs --df
timed node scripts/mine/extract-queries.mjs --run

step "6b/7 assemble — triplets, classifiers, query pairs"
timed $RUN scripts/mine/assemble.mjs --triplets --classify --pairs

step "7/7 freeze + verify"
if [ "${1:-}" = "--freeze" ]; then
  timed $RUN scripts/mine/assemble.mjs --eval --verify --i-have-brendans-go
else
  echo "eval left as a DRY RUN — pass --freeze to stamp cshl-eval-v1 FROZEN" | tee -a "$LOG"
  timed $RUN scripts/mine/assemble.mjs --eval --verify
fi

step "done"
ls -la data/mine/*.jsonl data/mine/eval/*.jsonl | tee -a "$LOG"
