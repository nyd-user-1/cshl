# LANE-LIBRARIAN — cshl-MESH-tagger + cshl-category, and the room map

Append-only timestamped log. Cap: **$10**. Branch `lane/librarian` (from `main` @ 137e5e9).

---

## 2026-08-21 — session start

- Read `/Code/scripts/RIG-DOCTRINE.md` and `/Code/scripts/ORCHESTRATION-DOCTRINE.md`. Governing
  rules carried into this lane: time-first-cost-second priced together (§0); real SAVE_STEPS
  and TYPE_MENU failover (§3, §4); completion is an event, never a noticed thing (§6);
  independent counts from source, never a self-report (Orch §2); a gate must subtract the
  rejections its own filters make (§10).
- Branch `lane/librarian` cut from `main`.

### Inventory, step 1 — the two datasets exist and are line-counted

| file | train | val | test |
|---|---|---|---|
| `data/mine/cshl-mesh-classify.*` | 102,734 | 12,882 | 13,128 |
| `data/mine/cshl-category-classify.*` | 259,890 | 32,277 | 32,794 |

### FINDING 1 (blocking, resolved below) — the datasets carry NO TEXT

Both are label-only records keyed by `slug`:

- mesh: `{slug, labels[{ui,descriptor,major,qualifiers}], major_labels[], author_keywords[], meta{family,pmid,journal,server}}`
- category: `{slug, label, meta{family,server,year}}`

So a text join is mandatory before anything can be trained, and the text recipe used for the
join must be the SAME recipe the rest of the program uses (Orch §4: one definition, imported —
plus a check that reads every copy that cannot import it). Recipe identification is next.

### Inventory, step 2 — join key resolves 100%

`data/mine/corpus-text.jsonl` (433,449 rows, 433,449 distinct `key`) carries the canonical
`embed_text`. Every slug in all six splits resolves against it:

| dataset | train | val | test | join |
|---|---|---|---|---|
| mesh | 102,734 | 12,882 | 13,128 | **100.00%** |
| category | 259,890 | 32,277 | 32,794 | **100.00%** |

Text recipe is declared once in `data/mine/eval/manifest.json` and sourced to
`scripts/embed-nsr/worker.mjs:94`: `left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), 4000)`.
The classifiers will consume `embed_text` verbatim — the same string the encoder saw. Orch §4.

### Inventory, step 3 — LEAKAGE AUDIT: clean, and re-derived rather than trusted

Both tasks also ship a heldout file and a **frozen 10,000-row eval set** inside `cshl-eval-v1`
(`cshl-eval-v1.{mesh,category}-classify.jsonl`), which I had not been told about and which is
the real benchmark for this lane.

| check | mesh | category |
|---|---|---|
| duplicate slugs within any split | 0 | 0 |
| train∩val, train∩test, val∩test | 0 / 0 / 0 | 0 / 0 / 0 |
| (train∪val∪test) ∩ heldout | **0** | **0** |
| (train∪val∪test) ∩ frozen eval-v1 | **0** | **0** |
| frozen eval ⊆ heldout | true | true |
| train/val/test rows landing in the 25% holdout band | **0** | **0** |
| heldout rows outside the holdout band | **0** | **0** |

Re-derived from the md5 rule myself, not read off the manifest.

### FINDING 2 — the manifest's declared split function is wrong as written

`manifest.json.split_rule.fn` says `md5(seed + key_number)` with
`split_seed: "cshl-training-pairs-2026-08-19"`, and the manifest advertises
`properties.splits_recomputable: "Any split can be re-derived ... without access to this lane"`.
Taken literally it does not reproduce: I got 20,500 / 11,576 / 11,775 mesh rows in the "wrong"
band. The code (`scripts/mine/assemble.mjs:61`) actually computes
`h32(`${SPLIT_SEED}:${key}`)` — a **colon** the manifest never declares. With the colon:
**zero** wrong-band rows on both tasks.

The holdout seed has no such problem (`HOLDOUT_SEED = "holdout:"` already carries its
separator, `lib.mjs:247`), which is why the holdout half of the audit passed first try.

Impact: low for correctness (the data is right), real for the manifest's stated re-derivability
claim — Orch §5, a verifier/claim that spans less than it advertises. Fix is one string in the
manifest; noted for whoever owns `assemble.mjs`, not silently patched by this lane.

### Inventory, step 4 — label spaces and the floors to beat

**cshl-category** — 76 classes, all 76 present in every split. Heavily imbalanced:

| | share |
|---|---|
| neuroscience | 14.36% (46,654) |
| microbiology | 7.52% |
| bioinformatics | 6.98% |
| … | |
| forensic medicine | 0.007% (24 papers) |

**Majority-class baseline = 14.451% accuracy on test.** That is the floor.

**cshl-MESH-tagger** — 20,174 distinct descriptors over 128,744 papers, mean 9.86 labels/paper
(median 9, max 42), 1,269,718 assignments. The tail is unlearnable, so the label space is cut
at train DF ≥ 20:

| min DF | labels | % assignments kept | % papers keeping ≥1 |
|---|---|---|---|
| 5 | 10,700 | 98.30% | 100.00% |
| 10 | 7,516 | 96.22% | 100.00% |
| **20** | **4,920** | **92.69%** | **99.99%** |
| 50 | 2,579 | 85.54% | 99.96% |
| 100 | 1,473 | 77.87% | 99.91% |

Chose **min DF 20 → 4,920 labels**: keeps 92.7% of the label mass while dropping 15,254
descriptors that appear <20 times in 102k papers and cannot be learned from that. Cost is 10
papers total (9 train, 1 test) losing every label and being dropped — counted, bounded, and
asserted, not waved away.

### FINDING 3 — the top MeSH descriptors are check tags, and they cannot split rooms

The most frequent descriptors are NLM *check tags*, not topics: Humans (56.6% of papers),
Animals (36.3%), Female (22.8%), Male (22.4%), Mice (15.2%), Adult (10.7%). A room map built
naively on descriptor frequency would produce a "Humans" room holding 57% of the corpus, which
is not a room. This constrains step 5 and is handled there — the splitting axis has to be a
MeSH *tree* subtree, not a raw descriptor count.

### FINDING 4 — MeSH coverage is 39.6%, not "about half"

Counted independently from source (`data/mine/mesh.jsonl`, not from any loader's self-report):
202,250 distinct slugs observed, of which 30,569 came back with **no** descriptors → **171,681
papers carry observed MeSH out of 433,449 = 39.6%**. The lane brief says "about half"; the
frozen manifest says "~36%". Both are wrong in different directions; the measured number is
39.6%. This matters because it sizes the inference job: **261,768 papers need a predicted tag**,
not ~217k.

Three provenance states, and the room map must keep them apart:

| state | papers | treatment |
|---|---|---|
| observed_with_labels | 171,681 | ground truth, never overwritten |
| observed_empty (we looked, PubMed had none) | 30,569 | predicted — still needs a room |
| never_observed (no published DOI / PMID) | 231,199 | predicted |

171,681 + 261,768 = 433,449. Corpus accounts exactly.

### Slices built — `scripts/classify/build-slices.py`, gate PASSED

Two-pass streaming (the 1.6 GB corpus never enters RAM). Emits `data/classify/`:

| file | rows |
|---|---|
| category.{train,val,test} | 259,890 / 32,277 / 32,794 |
| category.eval (**frozen cshl-eval-v1**) | 10,000 |
| mesh.{train,val,test} | 102,725 / 12,882 / 13,127 |
| mesh.eval (**frozen cshl-eval-v1**) | 10,000 |
| mesh.infer | 261,768 |

Rejections, each separately bounded rather than required to be zero (RIG-DOCTRINE §10):
9 train + 1 test mesh rows whose every label fell below min DF. `emitted + rejected == requested`
holds on all six splits.

**The gate caught a bug in my own first draft**, which is the point of having it: I asserted the
inference set was disjoint from *all* labelled data, and it failed with 178,753 overlaps. The
assertion was wrong, not the data — category labels cover 100% of the corpus, so demanding
inference-set disjointness from them demands an empty inference set. Corrected to the invariant
that actually matters: disjoint from every **MeSH** set including heldout and frozen eval →
**0**.

## The rig — `scripts/classify/`, ported not reinvented

`scripts/train/` is a FlagEmbedding contrastive rig; a classifier is a different trainer. So the
*pattern* was ported and the contrastive specifics dropped:

| carried over from `scripts/train/launch.sh` + `train.sh` | why |
|---|---|
| TYPE_MENU type+AZ walk, with the load-bearing `\|\| true` | RIG-DOCTRINE §3 — a type fallback, not just an AZ fallback |
| `FAKE_CAPACITY_FAIL` test hook | lets the failover be *tested*, not assumed |
| endpoint fence + SSM SecureString + xtrace off across the credential | the NSR rig leaked a live Neon URL into three uploaded logs exactly this way |
| watchdog `shutdown -h +N`, `instance-initiated-shutdown-behavior terminate` | no orphan boxes |
| real SAVE_STEPS + background S3 checkpoint syncer | the box's disk dies with the box |
| **weights upload the moment a task finishes** | NSR's reranker box terminated with a clean run and no weights because upload was last |
| OOM batch-halving loop | the 24 GB fallback types cannot hold the 48 GB box's batch |
| manifest disjointness gate before training | never train on a set that has not asserted holdout disjointness |

**New, and the cheapest insurance in the run:** an inline **SMOKE stage** runs the entire
pipeline — train both tasks, score both, infer — at toy scale (200 rows, 2 min) before any real
work starts. A broken unattended run now costs ~3 minutes instead of the whole box. Chose inline
over a separate rehearsal box because it gives the same protection without a second boot.

### FAKE_CAPACITY_FAIL test — the failover works, verified not assumed

```
type g6e.2xlarge: no capacity in subnet-09e840612db030382 — next AZ
type g6e.2xlarge: no capacity in subnet-0407bd1ff7e9d8c44 — next AZ
type g6e.2xlarge: no capacity in subnet-06b1914b54fc3e0c5 — next AZ
type g6e.2xlarge: no capacity in subnet-0200d8f947fcf9090 — next AZ
type g6e.4xlarge: no capacity in subnet-0200d8f947fcf9090 — next AZ
launched: i-0fakeSUCCESS (g6e.4xlarge, subnet-0407bd1ff7e9d8c44)
```
Survived 5 consecutive capacity errors under `set -e`, walked all four AZs, crossed to the next
type, captured the id, stopped. Cost: $0.

### Sizing — time first, cost second, priced together (RIG-DOCTRINE §0)

On-demand, us-east-1, pulled from the AWS pricing API rather than remembered:

| type | GPU | $/hr |
|---|---|---|
| **g6e.2xlarge** | 1× L40S 48 GB | **2.2421** |
| g6e.4xlarge | 1× L40S 48 GB | 3.0042 |
| g5.2xlarge | 1× A10G 24 GB | 1.2120 |
| g6.2xlarge | 1× L4 24 GB | 0.9776 |
| g6e.12xlarge | 4× L40S | 10.4926 |

4× L40S would cut ~1.2 h of wall-clock for ~+$4 and adds DDP failure surface to an unattended
run. Taking D8's precedent — *single L40S, certainty over speed* — and spending the time.

**max_len = 1024, and that is a measured choice.** embed_text averages 1,726 chars (~430
tokens), p95 2,893, capped at 4,000. At 512 tokens **22.6% of abstracts get truncated**; at 1024,
none do. Because cost tracks *actual* tokens (with `group_by_length` on), 1024 costs ~16% more
than 512 and loses nothing — the classifier sees the same text the retrieval encoder does.

Work: category 259,890 × 1 epoch + mesh 102,725 × 3 epochs = 568k train samples, plus ~600k
inference passes (test + eval + 261,768 corpus rows).

| | est. |
|---|---|
| setup, install, model download | ~15 min |
| smoke | ~3 min |
| cshl-category train + score | ~35 min |
| cshl-MESH-tagger train + score | ~45 min |
| baselines (prior + kNN over stock bge-m3) | ~12 min |
| infer 261,768 rows | ~15 min |
| **total** | **~2.1 h → ~$4.70** |

**Watchdog 180 min**, deliberately: worst case is 3 h × $3.0042 (the priciest menu type) =
**$9.01**, inside the $10 cap with nothing else spent. Checkpoints + RESUME_* make an overrun a
relaunch, not a loss.

## 2026-08-21 ~03:5xZ — box launched

`i-0421ce7340212d127`, **g6e.2xlarge** (L40S 46 GB), $2.2421/hr, watchdog 180 min
(shutdown 11:03:25Z). RUN_ID `20260821-librarian`.

The AZ failover fired **for real** on the way in, not just in the test:

```
type g6e.2xlarge: no capacity in subnet-0200d8f947fcf9090 — next AZ
type g6e.2xlarge: no capacity in subnet-06b1914b54fc3e0c5 — next AZ
type g6e.2xlarge: no capacity in subnet-0407bd1ff7e9d8c44 — next AZ
launched: i-0421ce7340212d127 (g6e.2xlarge, subnet-09e840612db030382)
```

Three of four AZs were out of g6e.2xlarge. Without the walk this launch simply fails.

On-box gates, all passed before a dollar of training:
- `transformers 4.57.6` ≥ 4.48, asserted rather than assumed (ModernBERT predates neither).
- manifest disjointness re-read on the box: all zeros, `pass: true`.
- **SMOKE PASSED in 127s** — both trainers, both scorers and the inference path exercised
  end-to-end at 200 rows before the real run started.

### Mid-flight patch (SSM), made before the stage it affects

Smoke showed the tagger emitting all 20 top-k labels at threshold 0.5 — meaningless for a
2-step model, but it exposed a design flaw worth fixing: `infer` wrote only labels above the
threshold, so a badly-chosen threshold could only be corrected by **re-running the box**.
Patched `cmd_infer` on the running box to persist the full top-20 probability vector, so the
threshold becomes a local, free decision. Verified `PATCH_OK` with an AST parse before leaving
it. The infer stage is ~1.5 h downstream of the patch, so nothing in flight was disturbed.

### Measured throughput (replaces the estimate)

`7.2 it/s` at batch 32, GPU 96% utilised, 22.7 GB of 46 GB resident. 230 samples/s.

| stage | steps | measured / projected |
|---|---|---|
| length-grouping pass (one-off, CPU) | — | 190 s |
| cshl-category, 1 epoch | 8,122 | ~19 min |
| cshl-MESH-tagger, 3 epochs | 9,630 | ~30 min (4,920-way BCE head) |

Revised total ~1.3 h against the 2.1 h estimate, so ~**$3.0** rather than $4.70. Two notes
against the estimate, both mine to own: the box is only half-used at batch 32 (22.7 of 46 GB)
— batch 64 would have been free and roughly 1.5× faster, and I sized conservatively for the
24 GB fallback types instead of sizing for the box I got and letting the OOM loop handle the
fallback. Not worth a restart; worth recording so the next run starts at 64.

### Room map, "before" baseline (observed MeSH only) — every paper placed

Built the room map against observed MeSH alone first, so the tagger's contribution is
measurable rather than asserted. First pass left **36,212 papers unplaced**: three buckets
(neuroscience ×2, bioinformatics ×1) whose members carry no MeSH at all and whose *single
year band* still exceeded 10,000.

Fixed on the named axis rather than by shredding: **91.7% of slugs encode their submission
date** (`2024.04.07.24305438`), so a year band that overflows is retried at half-year
resolution — "Neuroscience · unclassified (2025 H1)" is still a room a person can read.
An md5 shard would not be.

| | first pass | with half-year fallback |
|---|---|---|
| rooms | 164 | **170** |
| placed | 397,237 | **433,449** |
| unplaced | 36,212 | **0** |
| over ceiling | 0 | **0** |

Also fixed: three separate rooms were all named "Neuroscience · Neurons" because distinct
tree nodes resolve to the same nearest named ancestor. Unusable in a navigation UI. They are
now distinguished by the descriptor that separates each from its namesakes —
"Neurons — axons", "— cerebellum", "— hypothalamus" — computed within the collision group,
not against the corpus. Zero duplicate names remain.

## 2026-08-21 — cshl-category trained and scored

Trained 1 epoch, batch 32, max_len 1024, lr 3e-5, ModernBERT-base. Weights uploaded on
completion (599 MB) before MeSH started, per the upload-early rule.

| split | n | accuracy | macro F1 |
|---|---|---|---|
| held-out test | 32,794 | **65.09%** | 50.44% |
| frozen `cshl-eval-v1` | 10,000 | **65.17%** | 50.73% |
| majority-class floor | — | 14.45% | — |

The two held-out sets were drawn independently and agree to **0.08 pp**. That is worth more
than either number alone: it is the cheap version of Orch §6 (two implementations agreeing
retroactively validates both), and it says the test split is not lucky.

### The confusions are the product finding, not the error bar

Top confusions on test, `gold -> predicted`:

| confusion | n |
|---|---|
| genomics → bioinformatics | 170 |
| infectious diseases → epidemiology | 156 |
| biochemistry → biophysics | 136 |
| public and global health → epidemiology | 120 |
| biophysics → biochemistry | 118 |
| molecular biology → cell biology | 115 |
| animal behavior and cognition → neuroscience | 114 |
| epidemiology → infectious diseases | 111 |
| genetics → genomics | 100 |

Every one is a pair of genuinely overlapping fields, and several are **symmetric**
(biochemistry↔biophysics, epidemiology↔infectious diseases). A 65% accuracy against a
single-label target whose gold is *author self-assignment at submission* is not a 35% error
rate against ground truth — a large share of those "errors" are papers that could defensibly
sit in either category. That is a ceiling imposed by the label, not by the model, and it is
direct evidence for the cross-category rooms in the stretch: the model is rediscovering which
category boundaries are fictions.

## 2026-08-21 — cshl-MESH-tagger: trained, scored, and it DOES NOT clear the bar

Trained 3 epochs, batch 32, max_len 1024, 4,920-way BCE head. Weights uploaded (614 MB).

### First, a calibration fix — worth +8.8 pp and it cost nothing

At the default threshold 0.5 the tagger emitted **2.81 labels/paper against 9.10 observed** —
badly under-predicting, and micro-F1 read 36.81%. The threshold was never tuned. Swept it on
**val** (never test), and dumped val/test/eval probability vectors from the box while the model
was still resident so the sweep was possible at all:

| threshold | micro F1 | precision | recall | labels/doc |
|---|---|---|---|---|
| 0.50 (default) | 36.81 | 78.38 | 24.06 | 2.79 |
| 0.30 | 43.84 | 64.94 | 33.09 | 4.63 |
| **0.20 (chosen)** | **45.62** | 54.61 | 39.17 | 6.51 |
| 0.15 | 45.28 | 47.53 | 43.23 | 8.26 |
| 0.10 | 42.90 | 38.44 | 48.52 | 11.46 |

This is why the mid-flight patch mattered: `infer` originally wrote only labels above the
threshold, so a bad threshold could only be undone by re-running the box. It now keeps the full
top-20 vector, and the threshold became a free local decision.

### The verdict, on identical 5,000-document subsamples

The kNN arm scored a deterministic 5,000-row subsample; the model scored the full split. Not
comparable as-is, so I re-scored the model on **the exact same 5,000 rows**:

**held-out test**

| arm | micro F1 | P@5 | P@10 | R@10 | R@15 | labels/doc |
|---|---|---|---|---|---|---|
| prior (reads no text) | 11.34 | 30.83 | 19.44 | 20.25 | 22.71 | 1.00 |
| **kNN over stock bge-m3** | 39.67 | **61.68** | **45.28** | **52.32** | **60.24** | 3.35 |
| cshl-MESH-tagger @0.20 | **44.50** | 56.99 | 40.27 | 45.20 | 51.68 | 6.80 |
| delta (model − kNN) | **+4.83** | **−4.69** | **−5.01** | **−7.12** | **−8.57** | |

**frozen `cshl-eval-v1`** reproduces it: micro F1 +4.00, P@5 −5.42, R@15 −8.88.

**Read it honestly.** The model's only win is micro-F1, and that comparison is confounded —
the two arms sit at different label budgets (6.80 vs 3.35 labels/doc) and only the model's
threshold was tuned. The **threshold-free ranking metrics are the fair comparison**, and kNN
wins every one of them by 5–9 pp, consistently across two independent held-out sets.

> **Verdict: cshl-MESH-tagger does not beat kNN over embeddings we already store and index.
> By the brief's own criterion it is not worth serving.** The right MeSH labeller for this
> corpus is a kNN lookup over `preprint_embeddings`, which needs no new model, no new weights,
> and no inference box.

That is a real result and it is reported with the same prominence as the category win, per
RIG-DOCTRINE. Likely causes, not investigated tonight: macro-F1 on occurring labels is **1.86%**,
so the head has collapsed onto frequent descriptors and never learns the tail; 3 epochs over
103k examples is thin for a 4,920-way multi-label head; and MeSH labels are strongly predicted
by document similarity, which is precisely what a retrieval-trained embedding already encodes —
so the baseline was always going to be strong here.

**Consequence, acted on rather than noted:** the room map is built from the **kNN** labels, not
the model's. Using the arm I had just measured as worse would have been incoherent. kNN
propagation over all 261,768 unlabelled papers was launched on the box already paid for, at
$0 marginal cost, while the GPU sat at 34% during inference.

## 2026-08-21 09:13Z — box terminated cleanly, all artifacts uploaded

`i-0421ce7340212d127` launched 08:02:40Z, terminated ~09:13Z. **~70 min on a g6e.2xlarge.**
No orphan: verified by `describe-instances` (the three other running boxes in the account
predate this lane by days and belong to other work — untouched).

### The kNN propagation is verified, not assumed

Before building the room map on kNN labels I validated the **exact** scheme used
(similarity-weighted, K=15, pool = train split only, queries = the full held-out test split,
n=13,127 — no subsample, no leakage):

| arm, FULL held-out test (n=13,127) | P@5 | P@10 | R@10 | R@15 |
|---|---|---|---|---|
| prior (reads no text) | 30.83 | 19.44 | 20.25 | 22.71 |
| cshl-MESH-tagger @0.20 | 58.68 | 41.00 | 46.40 | 52.66 |
| **kNN propagation over stock bge-m3** | **63.39** | **46.36** | **53.72** | **61.82** |
| delta (kNN − tagger) | **+4.71** | **+5.36** | **+7.32** | **+9.16** |

Frozen `cshl-eval-v1` reproduces it (kNN P@5 63.23, R@15 61.50). The verdict does not depend
on which held-out set you pick, or on the 5,000-row subsample the box's own baseline used.

### The label table — `preprint_mesh_predicted`, both arms, distinguishable

Created new. Touches nothing else: no writes to `preprints`, no `preprint_embeddings*` table,
no table the frozen benchmark reads. No UPDATE, no DELETE against anything pre-existing.

| model | documents | label rows | mean/doc |
|---|---|---|---|
| `cshl-MESH-tagger` (t=0.20, val-tuned) | 259,752 | 1,651,920 | 6.36 |
| `knn-bge-m3-k15` (t=0.25) | 261,607 | 2,208,643 | 8.44 |

Both loaded deliberately. The tagger's predictions are the deliverable the brief asked for; the
kNN's are the ones the room map actually uses. Keeping both makes the decision auditable and
reversible instead of a choice buried in a script.

### Coverage, re-derived from the database at 09:16:39Z against 433,449 rows

| | papers | share |
|---|---|---|
| observed MeSH (NLM, ground truth) | 171,681 | 39.61% |
| **observed + predicted** | **433,288** | **99.96%** |
| still untagged | 161 | 0.04% |

The 161 are papers where even kNN produced nothing above 0.25. They still receive a room via
the fallback axes, which is why unplaced stays at zero.

**Calibration, stated where it cannot be missed:** the table is named `_predicted`, every row
carries `p`, `model` and `run_id`, and `mesh_provenance` separates *observed_empty* (PubMed was
asked, had none) from *never_observed* (no published DOI). Observed MeSH is never written here
and never overwritten. Any downstream count can tell a prediction from an NLM assignment.

## The room map — `docs/ROOM-MAP.md`

**252 rooms · every one of 433,449 papers placed · zero over the 10,000 ceiling · zero
without a room.** Ceiling is **provisional**: D9/LANE-CURVE has not run, so 10,000 is the
brief's placeholder, not a measured number. The script takes `--max-room N`; re-run it when
`HAYSTACK-CURVE.md` exists.

What the predicted labels actually bought — not "papers placed" (zero unplaced either way,
so that number says nothing) but **which axis** each paper is placed on:

| axis | observed MeSH only | + predicted | change |
|---|---|---|---|
| `mesh` (the preferred axis) | 140,664 | **282,801** | **+142,137** |
| `year` (fallback) | 94,930 | 47,287 | −47,643 |
| `no-mesh-facet` | 102,205 | **7,711** | **−94,494** |
| `category` (already fit) | 95,142 | 95,142 | 0 |

Rooms rose 170 → 252. A room split by MeSH subtree is a topic a researcher can choose; a room
split by year is a filing cabinet. That swap, for 142k papers, is the deliverable.

## Cross-category rooms (stretch) — done, and it produced a method finding

Ran only after items 4 and 5 were complete, on the laptop + Neon (no GPU, ~$0.02).

**The first design was wrong and was killed.** It issued one
`avg(embedding) WHERE key_number = ANY(ARRAY[...10,000 slugs])` per room — 252 near-full scans
of a 3.4 GB table on a 0.25-CU Neon, each carrying ~250 KB of SQL literal. Twelve minutes, no
measurable progress. Same shape as RIG-DOCTRINE §9 (megabytes of SQL text) crossed with an
aggregate no index can help. Rewritten to stage membership in a TEMP table and compute all 229
centroids in **one** join — completed in ~6 minutes. Cost of the mistake: ~12 min wall-clock and
about $0.01, itemised here rather than folded into the total.

**Finding: centroid cosine is not evidence of a shared room.** 19,439 cross-category pairs sit
at cosine ≥ 0.80, and the top candidates are packed into 0.986–0.990 — the measure barely
separates them. Their measured *interleaving* over that same band ranges 0.17 → 0.42. Proposing
merges on cosine alone would have married unrelated rooms that both sit near the corpus mean.
The membership test is what carries the claim.

Strongest proposals, ranked by interleaving (not similarity):

| interleaving | room A × room B | union |
|---|---|---|
| **0.42** | Cell Biology · Cell Differentiation × Developmental Biology · Cell Differentiation | 684 |
| **0.37** | Microbiology · RNA Virus Infections × Immunology · Virus Diseases | 961 |
| **0.36** | Bioinformatics · Genetic Techniques × Genomics · Sequence Analysis | 3,191 |
| 0.32 | Bioinformatics · Genetic Techniques × Genomics · Biology | 2,553 |
| 0.31 | Public And Global Health × Health Policy | 9,078 |

The membership evidence reads correctly: the first pair is STAP / naive-vs-primed pluripotency
papers, the second HIV and Zika. These are single communities split by a filing decision.

**Not applied.** The room map ships as the category-first partition; these are proposals for a
human. And the cap is stated loudly rather than hidden: **19,439 candidates existed, 12 were
tested**, chosen by the very cosine ranking I then showed to be a weak proxy — so they are not
necessarily the best 12.

---

## COMPLETE

### Deliverables

| asked for | delivered |
|---|---|
| inventory both datasets + leakage check | done — zero leakage, re-derived from the md5 rule, not read off the manifest |
| fine-tune one classifier per task | done — `cshl-category`, `cshl-MESH-tagger`, ModernBERT-base |
| score on UNTOUCHED test splits vs trivial + kNN baselines | done — plus the frozen `cshl-eval-v1` 10k as a second held-out set |
| weights to S3, publish nothing | `s3://cshl-embed-rxiv/models/cshl-classify/20260821-librarian/` — **nothing published to HF** |
| apply tagger to the corpus lacking MeSH, NEW table | `preprint_mesh_predicted`, both arms, coverage 39.61% → **99.96%** |
| room map, every room ≤ ceiling | `docs/ROOM-MAP.md` — **252 rooms, 0 over ceiling, 0 papers unplaced** |
| stretch: cross-category rooms | done, with its limits stated |

### The two headline results

**cshl-category is worth serving.**

| | accuracy | macro F1 |
|---|---|---|
| majority-class floor | 14.45% | 0.33% |
| kNN over stock bge-m3 | 58.12% | 35.46% |
| **cshl-category** | **65.09%** | **50.44%** |

+6.97 pp over kNN, +15 pp macro F1, and test/frozen-eval agree to 0.08 pp.

**cshl-MESH-tagger is NOT worth serving.** On the full held-out test split (n=13,127):

| | P@5 | P@10 | R@10 | R@15 |
|---|---|---|---|---|
| cshl-MESH-tagger @0.20 | 58.68 | 41.00 | 46.40 | 52.66 |
| **kNN over stock bge-m3** | **63.39** | **46.36** | **53.72** | **61.82** |

Beaten by 4.7–9.2 pp on every ranking metric, reproduced on the frozen eval. By the brief's own
criterion the model is not worth serving: **the right MeSH labeller for this corpus is a kNN
lookup over embeddings we already store and index** — no new model, no weights, no inference box.
The room map was therefore built on kNN labels, not the model's.

### Spend — itemised, waste included

| item | $ |
|---|---|
| g6e.2xlarge, 08:02:40Z → ~09:13Z (~71 min @ $2.2421/hr) | 2.65 |
| EBS 200 GB gp3 for the run | 0.03 |
| S3 storage + requests (~2.5 GB, prorated) | ~0.01 |
| Neon compute (vector pull, 3.9M-row COPY, centroid scan) | ~0.02 |
| **waste:** killed cross-category design, ~12 min of futile Neon scanning | ~0.01 |
| **waste:** first kNN launch failed on a missing `AWS_DEFAULT_REGION` (died in seconds) | ~0.00 |
| **TOTAL** | **≈ $2.72** against a $10 cap |

No orphan boxes: `i-0421ce7340212d127` terminated; verified by `describe-instances`. The three
other running instances in the account predate this lane by days and were not touched.

### What I got wrong, recorded

- **Sized the batch for the wrong box.** Chose batch 32 to survive the 24 GB fallback types, got
  a 46 GB L40S and used 22.7 GB of it. Batch 64 was free and ~1.5× faster; the OOM-halving loop
  existed precisely so I could have sized for the box I wanted. Next run starts at 64.
- **Shipped a gate with a wrong invariant.** My first slice gate required the inference set to be
  disjoint from *category* labels, which cover 100% of the corpus. It failed loudly with 178,753
  overlaps. The gate was wrong, not the data — and it working as designed is the argument for it.
- **Left the MeSH threshold at a default.** 0.5 was never justified; tuning on val was worth
  +8.8 pp micro-F1 and cost nothing. Caught only because smoke output looked odd.
- **Designed the centroid query badly** and spent 12 minutes proving it. See above.

### Awaiting a human decision

1. **Do not serve `cshl-MESH-tagger`.** Recommend kNN propagation instead. Both arms are in
   `preprint_mesh_predicted` so this is reversible. If the tagger is wanted anyway, the obvious
   next moves are more epochs, a class-balanced loss (macro-F1 on occurring labels is **1.86%** —
   the head has collapsed onto frequent descriptors), or distilling from the kNN labels.
2. **The 10,000 room ceiling is provisional.** D9/LANE-CURVE has not run. `build-room-map.py`
   takes `--max-room N`; re-run when `HAYSTACK-CURVE.md` exists.
3. **Cross-category merges are proposals, not applied.**
4. **`manifest.json.split_rule.fn` is wrong as written** (missing the `:` separator that
   `assemble.mjs:61` adds). One-string fix, owned by whoever owns the miner — not silently
   patched by this lane.

**Published nothing.** Weights and artifacts are in S3 only.
