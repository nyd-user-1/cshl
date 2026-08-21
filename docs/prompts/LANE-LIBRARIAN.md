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
