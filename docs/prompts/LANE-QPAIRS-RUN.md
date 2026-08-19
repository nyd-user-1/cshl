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

**PHASE: convert — running.** Started 2026-08-19T23:12Z, expected ~10 min.

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
