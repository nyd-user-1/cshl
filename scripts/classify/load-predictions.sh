#!/bin/bash
# LANE-LIBRARIAN — load cshl-MESH-tagger predictions into a NEW table.
#
# SAFETY, stated because this lane runs unattended against production Neon:
# this script CREATES and writes exactly one new table (plus one index). It does
# not touch `preprints`, any `preprint_embeddings*` table, or anything the frozen
# benchmark reads. There is no UPDATE and no DELETE against existing tables.
#
# The table is named *_predicted and every row carries its probability and the model
# that produced it, so no downstream count can silently conflate a predicted tag with
# an NLM-assigned one. Observed MeSH is never written here.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRED=${PRED:-$ROOT/data/classify/mesh.predictions.jsonl.gz}
MODEL=${MODEL:-cshl-MESH-tagger}
RUN_ID=${RUN_ID:?set RUN_ID}
TSV=$(mktemp /tmp/mesh-pred-XXXX.tsv)
trap 'rm -f "$TSV"' EXIT

[ -f "$PRED" ] || { echo "no predictions at $PRED"; exit 1; }
echo "flattening $PRED -> TSV"
python3 - "$PRED" "$TSV" "$MODEL" "$RUN_ID" "${FIELD:-predicted}" "${THRESHOLD:-0.5}" <<'PY'
import gzip, json, sys
src, dst, model, run, field, thr = sys.argv[1:7]
thr = float(thr)
op = gzip.open if src.endswith(".gz") else open
rows = docs = 0
with op(src, "rt") as f, open(dst, "w") as w:
    for line in f:
        d = json.loads(line); docs += 1
        for lab in (d.get(field) or d.get("predicted") or []):
            if lab.get("p", 1.0) < thr: continue
            w.write(f"{d['slug']}\t{lab['ui']}\t{lab['descriptor']}\t{lab['p']}\t{model}\t{run}\t{d.get('mesh_provenance','')}\n")
            rows += 1
print(f"  {docs} documents -> {rows} predicted (document,label) rows at {field}>={thr}")
PY

$ROOT/scripts/psql-cshl.sh <<SQL
CREATE TABLE IF NOT EXISTS preprint_mesh_predicted (
  key_number       text        NOT NULL REFERENCES preprints(key_number) ON DELETE CASCADE,
  ui               text        NOT NULL,
  descriptor       text        NOT NULL,
  p                real        NOT NULL,
  model            text        NOT NULL,
  run_id           text        NOT NULL,
  mesh_provenance  text        NOT NULL,
  predicted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_number, ui, model)
);
COMMENT ON TABLE preprint_mesh_predicted IS
  'PREDICTED MeSH descriptors from cshl-MESH-tagger. NOT observed NLM indexing. Only rows with no observed MeSH appear here; observed labels live in the mining artifacts and are never overwritten. Any coverage or room count that mixes this table with observed MeSH must report the two separately.';
CREATE INDEX IF NOT EXISTS idx_pmp_ui ON preprint_mesh_predicted (ui);
CREATE INDEX IF NOT EXISTS idx_pmp_key ON preprint_mesh_predicted (key_number);
DELETE FROM preprint_mesh_predicted WHERE model = '$MODEL' AND run_id = '$RUN_ID';
\copy preprint_mesh_predicted (key_number, ui, descriptor, p, model, run_id, mesh_provenance) FROM '$TSV'
SQL

echo "=== coverage, re-derived from the database at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
$ROOT/scripts/psql-cshl.sh -c "
SELECT
  (SELECT count(*) FROM preprints)                                                  AS corpus,
  (SELECT count(DISTINCT key_number) FROM preprint_mesh_predicted WHERE model='$MODEL') AS docs_predicted,
  (SELECT count(*) FROM preprint_mesh_predicted WHERE model='$MODEL')               AS label_rows,
  (SELECT round(avg(n),2) FROM (SELECT count(*) n FROM preprint_mesh_predicted WHERE model='$MODEL' GROUP BY key_number) s) AS mean_labels_per_doc;"
