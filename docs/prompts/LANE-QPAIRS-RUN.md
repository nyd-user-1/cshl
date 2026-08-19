# LANE-QPAIRS — the staged 40k query-pairs retrain

Append-only, timestamped. Mission: run the one experiment the CSHL report staged and did
not fire — retrain the encoder on **query-shaped** supervision (`cshl-query-pairs`), re-embed
into a third table, and score it against the **same frozen benchmark** as everything else.

The hypothesis under test, stated before the result is known: our 0.332 MeSH R@10 against
MedCPT's 0.457 is caused by an **objective mismatch** — we trained doc→doc (CITE) and
evaluated query→doc. If that is the whole story, query-shaped supervision closes the gap.
If it is not, the number will say so and the number gets published either way.

Budget: **hard cap $5.00 AWS**, approved by Brendan. Every box self-terminates on watchdog.

---

## Status

**PHASE: upload — running.** Started 2026-08-19T23:18Z. 601 MB at ~2.3 MB/s, expected ~4-5 min.
Next: probe `g6e.2xlarge` capacity by launching. Train is the long pole — ~45-75 min on g6e,
~2 h 20 m on g5.

---

## Log

### 2026-08-19T23:05Z — lane start, docs read
Read `CSHL-CPT-REPORT.md` (staged section, methodology, coverage), `RIG-DOCTRINE.md`,
`ORCHESTRATION-DOCTRINE.md`. Switched to branch `lane/rxiv-load` (the lane's branch; the
session opened on `main`, which was identical — `git diff main..lane/rxiv-load` empty).

### 2026-08-19T23:08Z — BLOCKER FOUND AND FIXED: the staged convert command could not work

The report stages this as step 1:

```
IN=data/mine/cshl-query-pairs.train.jsonl NAME=qpairs SUBSAMPLE=40000 \
  node --max-old-space-size=6144 scripts/train/from-mine.mjs
```

`scripts/train/from-mine.mjs` read the query side as `r.query?.slug`. Measured against the
actual file, independently, before running anything:

```
rows 424,753 · query-as-string 424,753 · query-as-obj-with-slug 0 · other 0
families: EXTRACT 259,920 · MESH 102,667 · AUTHORKW 62,166
```

**Every record in `cshl-query-pairs` carries `query` as a literal query string**, not a slug
into the corpus — which is the entire point of the set. The converter was written for
`cshl-triplets` (CITE), where the query *is* a paper. Run as staged, `r.query?.slug` is
`undefined` on all 424,753 rows, every row falls into the `dropped` counter, and the script
writes an **empty `train.jsonl`** and prints its normal success line. `upload-slice.sh` would
have uploaded it (it gates on `disjointness.pass`, which was a hardcoded literal `true`), and
`train.sh` would have accepted it.

This is exactly the dominant failure mode both doctrines name: **an operation that reports
success while doing nothing.** It was caught by measuring the input rather than trusting the
staged command.

Fix, in `scripts/train/from-mine.mjs` only (`train.sh` and `launch.sh` are fenced for the rig
lane and were not touched):

- handle both record shapes explicitly, named in comments; an unrecognised shape is a drop,
  never a silent pass;
- `ABORT` with a non-zero exit if 0 records are convertible — an empty slice can no longer be
  written at all;
- count families in what is **EMITTED**, not what is read, and record both in the manifest
  (`families_emitted` vs `families_convertible`);
- `disjointness.pass` is now **computed** from a post-hoc re-scan of the emitted set against
  the frozen benchmark's gold papers, not a hardcoded `true`. It used to be a claim; it is
  now a check;
- disclose the count of emitted training queries whose text also appears as a benchmark query
  string. This is **not** a leak — the benchmark splits by *paper*, deliberately — but it is
  the first thing a reader will ask about, so it is measured rather than argued;
- stream the 290 MB input instead of `readFileSync().split()`.

### 2026-08-19T23:12Z — convert fired

### 2026-08-19T23:14Z — convert VERIFIED

```
read 424,753 · convertible 424,753 · dropped 0 · rejected for touching the frozen benchmark 0
query side: 424,753 literal-text · 0 slug-into-corpus
  MESH:     102,667 ->  9,668
  AUTHORKW:  62,166 ->  5,854
  EXTRACT:  259,920 -> 24,477
EMITTED families: {"MESH":9668,"AUTHORKW":5854,"EXTRACT":24477}
EMITTED disjointness: 0 references to frozen-benchmark gold papers (must be 0)
EMITTED query-string overlap with benchmark: 157 / 39,999
wrote 39,999 pairs -> data/train/qpairs/train.jsonl   (601 MB)
```

Stratified across all three families, counted **in what was emitted**. 39,999 rather than
40,000 because the per-family `round()` of the proportional take loses one.

`rejected_for_overlap 0` deserves a sentence, because zero is exactly the number a broken
check returns. It is not broken: `evalKeys` loaded 6,203 gold papers (non-zero, and the same
set gates the negatives). Zero rejections means lane-mine had **already** excluded held-out
papers from the train split using the same `md5("holdout:"||key)` rule. This run is the
independent second count that confirms it — which is the only kind of confirmation the
orchestration doctrine accepts.

Independent verification of the emitted file itself, re-read from disk rather than taken from
the converter's report:

```
lines 39,999 · malformed 0
query chars:    min 11 · avg 110 · max 273        <- genuinely query-shaped
positive chars: avg 1,768 · max 4,000             <- title+abstract, the 4000-char cap
negatives/row:  8 x 34,203 · 7 x 5,399 · 6 x 385 · 5 x 11 · 4 x 1
first row query: "D. melanogaster; Embryo, Nonmammalian; Single-Cell Analyses; Transcriptome"
```

That average query length of 110 characters against an average positive of 1,768 is the whole
experiment in one line: this is query->doc supervision, where the CITE run was doc->doc.

`GROUP_SIZE=8` consumes 1 positive + 7 negatives; ~1% of rows carry fewer than 7 negatives and
FlagEmbedding will sample with replacement for those. Noted, not corrected.

### 2026-08-19T23:16Z — third vector table created, both existing tables untouched
```
preprints                    433,449
preprint_embeddings_medcpt   433,449
preprint_embeddings_cshl     433,449   <- the CITE run, untouched
preprint_embeddings_cshl_qp        0   <- created empty, this run's target
```
DDL added to `scripts/eval/sidecars.sql`, HNSW (cosine, matching the arm's metric) to
`scripts/eval/indexes.sql` — to be built AFTER the sweep, per that file's own rule. One
registry entry `cshl_qp` added to `scripts/eval/score.mjs`, which is all three of the scorer,
the doc->doc scorer and the coverage gate, since both import `REGISTRY` from it.

### 2026-08-19T23:14Z — capacity/quota preconditions checked (free)
```
Running On-Demand G and VT instances : 64 vCPU     (g6e.2xlarge and g5.2xlarge are 8 each)
All G and VT Spot Instance Requests  :  8 vCPU
g6e.2xlarge offered in: us-east-1a, 1b, 1c, 1d
g5.2xlarge  offered in: us-east-1a, 1b, 1c, 1d, 1f
GPU instances currently running: none
```
Quota is not the constraint. Capacity is unknown until a launch is attempted, and per the
rig doctrine an unexercised limit produces no error — so the launch attempt *is* the probe,
and a capacity error is an answer rather than a failure. `g6e.2xlarge` first.

Also confirmed the IAM role `cshl-embed` already carries `s3:PutObject` on `eval/*` (added
after the incident in the report). Without it `train.sh` §5b's query-vector upload — which
ends in `|| true` — would have failed silently and left the arm unscoreable.

---

## Spend ledger

| when | item | $ | note |
|---|---|---:|---|
| — | convert, local | 0.00 | free |
| — | quota/capacity/IAM checks | 0.00 | free, API reads only |
| | **running total** | **0.00** | cap $5.00 |
