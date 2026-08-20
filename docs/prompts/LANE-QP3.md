# LANE-QP3 — the keyword offensive (D8)

Append-only, timestamped. Branch `lane/rxiv-load`. Cap **$12**.

Targets: encoder AUTHORKW > 0.8076 (MedCPT); system (QP3 + cshl-RR) AUTHORKW
> 0.8577 and blended > 0.6510 (medcpt + MedCPT-CE).

---

## 2026-08-20T??:??Z — branch

D8 names `lane/rxiv-load`. Local `lane/rxiv-load` was a strict ancestor of
`lane/proof-page` (31 commits behind `origin/lane/rxiv-load`'s tip counted
against proof-page), and the two documents D8 orders me to read first —
`LANE-WIN.md` and `LANE-KEYWORDS.md` — live only on `lane/proof-page`.
Checked out `lane/rxiv-load` and **fast-forwarded** it to `59f94ae` (no merge
commit, no content decision made). Working on `lane/rxiv-load` as instructed,
with every document D8 depends on present.

---

## 2026-08-20T??:??Z — FIX FIRST (lead's addition (a))

### The report, and what was actually there

> `cshl_qp2+cshl_rr.json` has a wrong aggregate metrics block (it duplicates
> the base encoder's numbers).

**The numbers in that file were never wrong.** I re-derived all four system
arms from their source `reranked-*.json` + the frozen `qrels.tsv`/`queries.jsonl`
with an independent scorer (`scratchpad/verify.mjs`, no import from the repo's
scorers) and every one of the 4 arms x 2 families x 6 metrics reproduced the
stored digits exactly. `cshl-QP2+cshl-RR` blended:

```
AUTHORKW  n=759   r1 0.5955  r5 0.7589  r10 0.8024  r50 0.8669  mrr 0.6706  ndcg 0.7002
MESH      n=1241  r1 0.3062  r5 0.4811  r10 0.5488  r50 0.6728  mrr 0.3855  ndcg 0.4193
```

MESH 0.5488 / AUTHORKW 0.8024 — matching the lead's independent verification.
Guards re-run at assertion time: 2000/2000 rows scored, 0 missing, 0 rows where
the reranked list was not a permutation of the raw list. Source digests differ
between arms that must differ (`reranked-medcpt_cshlrr` a8f… vs
`reranked-medcpt_medcptce` 7f1…; identical file *sizes* are expected — same
qids, same doc ids, permuted).

### So what was the defect? A shape defect, and it is a real one

`score-rerank-cshl.mjs` wrote

```
metrics: { raw: {FAM:{seg}}, reranked: {FAM:{seg}} }
```

while **every** encoder arm written by `score.mjs` writes `metrics: {FAM:{seg}}`.
Two live costs:

1. **A silent-null for any generic reader.** `scripts/publish-nsr/fill-card.mjs`
   ingests every `results/*.json` and does `m[family] ?? Object.keys(m).find(k => k !== 'TITLE')`.
   For a system arm that resolves to the literal key `'raw'`, then reads
   `m['raw'].blended` — undefined — and emits **null** into a model card. No error.
2. **A guaranteed human misread.** `metrics.raw` is the first block in the file
   and is byte-identical to the base encoder's own `results/cshl_qp2.json`. Anyone
   opening the file sees the base encoder's digits where they expect the arm's,
   and concludes the rerank did nothing. That is exactly the report I was handed.

Both are the dominant failure mode the house rules name: an operation that
reports success while conveying nothing.

### Fix

`metrics` now means the same thing for every file in `results/` — **this arm's
numbers** — and the raw base-encoder top-50 baseline moves to `base_metrics`,
named for what it is, with a `metrics_note` stating the contract inline.

Regenerated all four system arms (the earlier `cshl_qp+cshl_rr` row carried the
identical defect, as did both MedCPT system rows). Verified against pre-fix
copies: `new.metrics == old.metrics.reranked` and `new.base_metrics == old.metrics.raw`
for **4/4** files — the shape changed, not one digit.

| arm | AUTHORKW R@10 | MESH R@10 |
|---|---|---|
| `cshl_qp+cshl_rr` | 0.7668 | 0.5238 |
| `cshl_qp2+cshl_rr` | **0.8024** | **0.5488** |
| `medcpt+cshl_rr` | 0.8235 | 0.5439 |
| `medcpt+medcpt_ce` | 0.8577 | 0.5246 |

### HERO-STAT check — **does not verify at +186%**

Asked: cshl-QP2+cshl-RR MESH R@1 vs stock bge-m3's 0.1176, flag if near/past +186%.

```
0.3062 / 0.1176 = 2.604x  ->  +160.4%
```

**+160.4%, not +186%** — 26 points short, so I am not flagging it as HERO-STAT
on the stated threshold. Nothing in the grid lands near +186%: the largest
relative jump anywhere is this one. For the record, the full vs-stock grid:

| metric | MESH QP2 | MESH QP2+RR | AUTHORKW QP2 | AUTHORKW QP2+RR |
|---|---:|---:|---:|---:|
| R@1 | +128.8% | **+160.4%** | +17.0% | +30.2% |
| R@5 | +101.8% | +117.1% | +18.7% | +24.9% |
| R@10 | +83.1% | +91.8% | +17.2% | +23.0% |
| MRR | +105.2% | +124.3% | +17.8% | +27.8% |
| nDCG@10 | +99.8% | +115.9% | +17.7% | +26.8% |

The honest headline is still large and clean: **MeSH R@1 more than 2.6x over
stock bge-m3, 0.1176 -> 0.3062.** I am reporting 2.6x rather than the 2.86x the
threshold implies.

---

## 2026-08-20T07:30–07:53Z — D8 step 2 preflight: OAKW verified, slice spec fixed

D8 makes OAKW conditional: *"verify its manifest + benchmark disjointness before
use; if the file is missing or fails its gates, proceed at 90k without OAKW and
say so loudly."* **It passes, so the slice is the full 140k.** Verified from the
files, not from the manifest's own counters:

```
rows                                 479,969   == manifest.files.rows          ✓
sha256  7956fddf3f8115041fad08712c2cd61b16cb50b70c448ad1fbc87497b34811ea        ✓ (matches manifest)
families                             OAKW 235,482 · OATOPIC 244,487
negatives/row                        {8: 479,969}   — none thin
POSITIVES that are cshl-eval-2k gold        0   (must be 0)
NEGATIVES that are cshl-eval-2k gold        0   (must be 0)
POSITIVES that are cshl-eval-v1 gold        0   (must be 0)
NEGATIVES that are cshl-eval-v1 gold        0   (must be 0)
train query strings == a benchmark query    0
```

OAKW supplies 235,482 usable rows against the 50,000 the slice asks for. Only
the OAKW family is taken; **OATOPIC is not used**, per its own manifest's caveat
that it is a classification target rather than a query.

**A gate-coverage trap, checked rather than assumed.** Every training slice in
this program gates against `cshl-eval-v1/qrels.tsv`, but the arm is scored on
`cshl-eval-2k`. If 2k's gold papers were not covered by v1's gate, training
would leak into the benchmark and every number would be worthless. Measured:

```
cshl-eval-2k unique gold papers   1,839
cshl-eval-v1 unique gold papers   6,203
in 2k but NOT in v1                   0      <- the v1 gate strictly covers 2k
```

(943 of 2k's *qids* are absent from v1, so the qid sets differ — but the holdout
is defined over PAPERS, and at paper level 2k ⊂ v1. The gate holds.)

### The slice spec, built and verified

```
FAMILY_TAKE  MESH:45,000  AUTHORKW:40,000  OAKW:50,000  EXTRACT:5,000
  MESH:     102,667 convertible -> 45,000
  AUTHORKW:  62,166 convertible -> 40,000   (all of the family is 62,166; 40,000 as specified)
  OAKW:     235,482 convertible -> 50,000
  EXTRACT:  259,920 convertible ->  5,000
  OATOPIC:  244,487 convertible ->      0   (not named)
EMITTED families      {"MESH":45000,"AUTHORKW":40000,"OAKW":50000,"EXTRACT":5000}
FAMILY_TAKE VERIFIED  families_emitted matches the spec exactly (140,000 pairs)
EMITTED disjointness  0 references to frozen-benchmark gold papers
query-string overlap  695 / 140,000 (disclosed; the benchmark splits by paper)
```

---

## 2026-08-20T07:45Z — lead intervention: the converter is bulk processing, and it broke

The lead killed the local converter at **7.85 GB RSS on an 8 GB laptop** (red
memory pressure, 4.9 GB swap). Correct call and my error: the text sidecar is
1.6 GB of strings and the emitted slice ~2.2 GB, both resident, which is exactly
the bulk data processing RIG-DOCTRINE puts on a box.

It had also already produced a **corrupt artifact**, which is the more
interesting half:

```
data/train/qpairs3/train.jsonl   4,294,967,296 bytes  (exactly 2^32)
                                       270,192 lines  (for 140,000 rows)
ERR_SYSTEM_ERROR: writev failed
```

Every gate printed PASS — `FAMILY_TAKE VERIFIED`, `0 references to
frozen-benchmark gold papers`, `140,000 pairs` — and *then* the write produced
1.9x the rows it had verified and died. Piped through `tail`, the shell reported
**exit 0**. Three of this program's named failure modes in one line: an
operation that reports success while doing nothing useful, a verification that
ran before the thing it verified existed, and an exit code that lied.

**Root cause, and it is a real bug, not a laptop symptom.** The writer read:

```js
for (const x of out) if (!ws.write(...)) { /* backpressure ok at this size */ }
```

`ws.write()` returning `false` means *stop*. Ignoring it queues every unflushed
chunk in memory and hands the backlog to one `writev()`, which fails at 2^32
bytes. The comment was true when the slice was 40k pairs. At 140k it is false,
and nothing re-checked it. Fixed in both `from-mine.mjs` and `mine-ance.mjs` by
awaiting `'drain'`; both now also stream their output from a generator rather
than materialising it.

### Structural response: the whole pre-train pipeline moves to one box

Not just the converter — the ANCE mine has the same shape (the same 1.6 GB
sidecar plus 140k x 1024-d query vectors) and needs a GPU and Neon besides. So
`scripts/train/prep-qp3.sh` + `scripts/train/launch-prep.sh` (new) do all of
stage 1-3 on one self-terminating box: build the slice, embed its 140k queries
with the cshl-QP2 checkpoint, ANCE-remine against
`preprint_embeddings_cshl_qp2`, verify, upload to S3. The laptop holds only
manifests. `launch-prep.sh` is a port of the proven `launch.sh` — SSM
SecureString + endpoint fence, the `set +x` window around the credential, reused
embed role/SG, TYPE_MENU walked type-by-type across every offered AZ with the
load-bearing `|| true`, watchdog, terminate-on-shutdown, DRYRUN. Its one policy
change is `s3:PutObject` on `train/*` and `prep/*`, which `launch.sh`'s policy
(logs + models only) does not grant — the box would otherwise have run the
entire pipeline and died on AccessDenied at the upload.

---

## 2026-08-20T07:53–08:15Z — the ANCE miner had a dead gate. Proven, then fixed.

`mine-ance.mjs` was pre-staged and smoke-tested under LANE-WIN, and its header
names false negatives as the failure that makes ANCE rounds silently worse. It
lists among its gates: *"the positive itself can never be a negative."*

**On the path the real mine would have used, that gate was dead.** The script
recognised two QMETA shapes. The smoke test ran the `benchmark-dir` shape, where
gold comes from `qrels.tsv` and the gate is real. The full mine was documented to
run the `train-jsonl` shape — a FlagEmbedding `train.jsonl`, which is text-only
and carries no paper identity — and that branch builds:

```js
meta.set(`T-${i++}`, { text: o.query, gold: new Set(), posText: o.pos?.[0] })
                                      ^^^^^^^^^^^^^^ empty, always
```

Every `m.gold.has(...)` check downstream therefore rejects nothing. The gate the
smoke test demonstrated is **not the gate the real mine would have used**.

### Proven on real data rather than argued

`from-mine.mjs` now emits `slice-slugs.jsonl` beside every `train.jsonl` — row
for row, carrying the positive's slug and the original negatives — and
`mine-ance.mjs` gained a third named shape that reads it. Test: take 40 rows,
and use as each query's vector **the positive document's own embedding, pulled
from the very table the miner searches**, so the positive is rank 1 by
construction and a working gate must strike it.

| run | shape | `gold landed` | own-gold struck | positive emitted as its own negative |
|---|---|---|---:|---:|
| A | `slice-slugs` (fixed) | `{"top1":40}` | **40** | 0 |
| B | `train-jsonl` (old) | `{}` | **0** | 0 (masked — see below) |
| C | `train-jsonl` (old), `SKIP_TOP=0` | — | **0** | **5 of 5** |

Run C is the proof. With `SKIP_TOP=0` the old path emitted the query's own
correct answer as its own hard negative on **every** writable row, and the only
thing that caught it was a belt-and-braces text comparison I added at the write
step. Run B shows why it was invisible: at `SKIP_TOP=5` a positive ranked 1-5 is
discarded as a likely-unlabelled positive anyway, so the dead gate is masked
*for exactly the queries the model already gets right*. It bites on the rest —
and LANE-WIN's own gold-rank histogram measured **~42% of queries with the gold
below rank 1 and ~10% below rank 10**, which is the population it would have hit.

### Two more defects the fixture found before the box did

1. **Rows dropped silently when ANCE negatives had no text.** A row whose mined
   negatives failed text resolution was skipped, so the slice would come out
   under 140,000 and the FAMILY_TAKE mix that was verified at build time would
   quietly not be the mix trained on. Now falls back to the inherited negatives.
   In the fixture this turned **1 written row into 36**, still exit 0 either way.
2. **The fallback could never resolve.** `need` — the slug set whose text gets
   loaded — included inherited negatives only for rows that had *already* failed
   to mine, so a successfully-mined row's fallback had no text behind it. Fixed;
   the fixture then rescued **31 of 35** rows instead of 0.

D8's rule "ANCE negatives wherever mined; existing negatives elsewhere" is now
what the code does, counted per family in the manifest as `negatives_source`.
