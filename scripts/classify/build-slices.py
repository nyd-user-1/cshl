#!/usr/bin/env python3
"""
LANE-LIBRARIAN — build the classifier training slices.

The mined datasets (data/mine/cshl-{mesh,category}-classify.*.jsonl) are LABEL-ONLY:
{slug, labels...}. The text they refer to lives in data/mine/corpus-text.jsonl under
`embed_text` -- the single canonical string declared in data/mine/eval/manifest.json
and sourced to scripts/embed-nsr/worker.mjs:94. Anything that feeds a model consumes
embed_text verbatim (Orch doctrine #4: one definition, imported).

Two-pass and streaming ON PURPOSE: this is an 8 GB laptop and corpus-text.jsonl is
1.6 GB. Pass 1 holds only slug -> (split, label) in RAM; pass 2 streams the corpus
once and appends each row straight to its output file. Text is never accumulated.

Emits, under data/classify/:
  {task}.{train,val,test}.jsonl   {"slug","text","y"}   y = int | list[int]
  {task}.eval.jsonl               the FROZEN cshl-eval-v1 10k set (already has text)
  {task}.labels.json              the label space, index-ordered
  mesh.infer.jsonl                the corpus rows with NO observed MeSH (room-map input)
  slices-manifest.json            counts, digests, disjointness -- the gate the box reads
"""
import json, os, sys, hashlib
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MINE = f"{ROOT}/data/mine"
EVAL = f"{ROOT}/data/mine/eval"
OUT  = f"{ROOT}/data/classify"
os.makedirs(OUT, exist_ok=True)

MESH_MIN_DF = int(os.environ.get("MESH_MIN_DF", "20"))
SPLITS = ["train", "val", "test"]

def h32(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 0xffffffff

# ---------------------------------------------------------------- pass 1: labels
print("pass 1: reading label-only datasets", flush=True)
cat_rows, mesh_rows = {}, {}          # slug -> (split, payload)
for split in SPLITS:
    for line in open(f"{MINE}/cshl-category-classify.{split}.jsonl"):
        r = json.loads(line); cat_rows[r["slug"]] = (split, r["label"])
    for line in open(f"{MINE}/cshl-mesh-classify.{split}.jsonl"):
        r = json.loads(line); mesh_rows[r["slug"]] = (split, [x["ui"] for x in r["labels"]])

# Three provenance states, and the room map must be able to tell them apart:
#   observed_with_labels -- PubMed gave descriptors. Ground truth. Never predicted over.
#   observed_empty       -- we looked, PubMed had none. Needs a predicted tag anyway,
#                           because it still needs a room; flagged so no count conflates it.
#   never_observed       -- no published DOI / no PMID. The bulk of the inference set.
# Only observed_with_labels is excluded from inference: predicting a label for a paper
# that already has an observed one would overwrite ground truth with a guess.
mesh_labeled, mesh_observed_empty = set(), set()
for line in open(f"{MINE}/mesh.jsonl"):
    d = json.loads(line)
    (mesh_labeled if d.get("mesh") else mesh_observed_empty).add(d["key"])
mesh_observed_empty -= mesh_labeled
print(f"  category rows {len(cat_rows)}  mesh rows {len(mesh_rows)}", flush=True)
print(f"  mesh observed_with_labels {len(mesh_labeled)}  observed_empty {len(mesh_observed_empty)}", flush=True)

# ------------------------------------------------------- label spaces (TRAIN only)
cat_labels = sorted({v[1] for v in cat_rows.values() if v[0] == "train"})
cat_ix = {l: i for i, l in enumerate(cat_labels)}

df = Counter()
for split, uis in mesh_rows.values():
    if split == "train":
        for u in uis: df[u] += 1
mesh_labels = sorted([u for u, n in df.items() if n >= MESH_MIN_DF])
mesh_ix = {u: i for i, u in enumerate(mesh_labels)}
ui2desc = {}
for line in open(f"{MINE}/cshl-mesh-classify.train.jsonl"):
    for x in json.loads(line)["labels"]:
        if x["ui"] in mesh_ix: ui2desc[x["ui"]] = x["descriptor"]

print(f"  category label space: {len(cat_labels)}", flush=True)
print(f"  mesh label space: {len(mesh_labels)} (train DF >= {MESH_MIN_DF}, of {len(df)} seen)", flush=True)

json.dump({"labels": cat_labels}, open(f"{OUT}/category.labels.json", "w"))
json.dump({"labels": mesh_labels, "descriptors": [ui2desc.get(u, u) for u in mesh_labels],
           "min_df": MESH_MIN_DF}, open(f"{OUT}/mesh.labels.json", "w"))

# ------------------------------------------------- pass 2: stream corpus, write out
print("pass 2: streaming corpus-text.jsonl", flush=True)
fh = {f"category.{s}": open(f"{OUT}/category.{s}.jsonl", "w") for s in SPLITS}
fh.update({f"mesh.{s}": open(f"{OUT}/mesh.{s}.jsonl", "w") for s in SPLITS})
fh["mesh.infer"] = open(f"{OUT}/mesh.infer.jsonl", "w")

counts = Counter(); dropped = Counter(); seen = 0
for line in open(f"{MINE}/corpus-text.jsonl"):
    d = json.loads(line); seen += 1
    k, text = d["key"], d.get("embed_text") or ""
    if k in cat_rows:
        split, lab = cat_rows[k]
        if not text.strip(): dropped["category_empty_text"] += 1
        else:
            fh[f"category.{split}"].write(json.dumps({"slug": k, "text": text, "y": cat_ix[lab]}) + "\n")
            counts[f"category.{split}"] += 1
    if k in mesh_rows:
        split, uis = mesh_rows[k]
        y = sorted({mesh_ix[u] for u in uis if u in mesh_ix})
        if not text.strip(): dropped["mesh_empty_text"] += 1
        elif not y:          dropped[f"mesh_all_labels_below_min_df_{split}"] += 1
        else:
            fh[f"mesh.{split}"].write(json.dumps({"slug": k, "text": text, "y": y}) + "\n")
            counts[f"mesh.{split}"] += 1
    if k not in mesh_labeled:
        if not text.strip(): dropped["infer_empty_text"] += 1
        else:
            fh["mesh.infer"].write(json.dumps({
                "slug": k, "text": text, "category": d.get("category"), "year": d.get("year"),
                "server": d.get("server"),
                "mesh_provenance": "observed_empty" if k in mesh_observed_empty else "never_observed",
            }) + "\n")
            counts["mesh.infer"] += 1
            counts["infer." + ("observed_empty" if k in mesh_observed_empty else "never_observed")] += 1
for f in fh.values(): f.close()
print(f"  corpus rows seen {seen}", flush=True)

# -------------------------------------------------------- frozen eval sets (10k ea)
for task, key in [("category", "label"), ("mesh", "labels")]:
    n = 0; skipped = 0
    with open(f"{OUT}/{task}.eval.jsonl", "w") as w:
        for line in open(f"{EVAL}/cshl-eval-v1.{task}-classify.jsonl"):
            r = json.loads(line)
            if task == "category":
                if r[key] not in cat_ix: skipped += 1; continue
                y = cat_ix[r[key]]
            else:
                y = sorted({mesh_ix[x["ui"]] for x in r[key] if x["ui"] in mesh_ix})
                if not y: skipped += 1; continue
            w.write(json.dumps({"slug": r["slug"], "text": r["embed_text"], "y": y}) + "\n"); n += 1
    counts[f"{task}.eval"] = n; dropped[f"{task}_eval_unrepresentable"] = skipped

# ------------------------------------------------------------------- the gate
# RIG-DOCTRINE #10: a completeness gate on a FILTERED output must assert
# emitted == requested - rejections, never emitted == requested. Each rejection
# counter is bounded separately below rather than required to be zero.
expect = {
    "category.train": 259890, "category.val": 32277, "category.test": 32794,
    "mesh.train": 102734, "mesh.val": 12882, "mesh.test": 13128,
}
problems = []
for k, req in expect.items():
    task = k.split(".")[0]
    rej = sum(v for kk, v in dropped.items() if kk.startswith(task) and k.split(".")[1] in kk) \
          + dropped.get(f"{task}_empty_text", 0)
    if counts[k] + rej != req:
        problems.append(f"{k}: emitted {counts[k]} + rejected {rej} != requested {req}")
# bound the rejections: they exist to fire, but only a little
for kk, v in dropped.items():
    if "empty_text" in kk and v > 500: problems.append(f"rejection {kk}={v} exceeds bound 500")
    if "below_min_df" in kk and v > 200: problems.append(f"rejection {kk}={v} exceeds bound 200")

# disjointness, re-derived here rather than inherited
def slugs(p): return {json.loads(l)["slug"] for l in open(p)}
tr = slugs(f"{OUT}/category.train.jsonl") | slugs(f"{OUT}/mesh.train.jsonl")
va = slugs(f"{OUT}/category.val.jsonl")   | slugs(f"{OUT}/mesh.val.jsonl")
te = slugs(f"{OUT}/category.test.jsonl")  | slugs(f"{OUT}/mesh.test.jsonl")
ev = slugs(f"{OUT}/category.eval.jsonl")  | slugs(f"{OUT}/mesh.eval.jsonl")
inf = slugs(f"{OUT}/mesh.infer.jsonl")
# The inference set is the papers with no OBSERVED MeSH. It overlaps the category
# splits by construction -- category covers 100% of the corpus, so demanding
# disjointness from it would be demanding an empty inference set. The invariant
# that actually matters is disjointness from every MeSH set, ground truth included.
mesh_all = (slugs(f"{OUT}/mesh.train.jsonl") | slugs(f"{OUT}/mesh.val.jsonl")
            | slugs(f"{OUT}/mesh.test.jsonl") | slugs(f"{OUT}/mesh.eval.jsonl")
            | {json.loads(l)["slug"] for l in open(f"{EVAL}/cshl-mesh-classify.heldout.jsonl")})
disj = {
    "train_x_test": len(tr & te), "train_x_val": len(tr & va),
    "train_x_frozen_eval": len(tr & ev), "val_x_frozen_eval": len(va & ev),
    "test_x_frozen_eval": len(te & ev),
    "infer_x_mesh_labeled_any": len(inf & mesh_all),
    "train_in_holdout_band": sum(1 for s in tr if h32("holdout:" + s) < 0.25),
}
disj["pass"] = all(v == 0 for k, v in disj.items() if k != "pass")
if not disj["pass"]: problems.append(f"disjointness FAILED: {disj}")

man = {"built_by": "LANE-LIBRARIAN", "mesh_min_df": MESH_MIN_DF,
       "counts": dict(counts), "rejections": dict(dropped),
       "label_space": {"category": len(cat_labels), "mesh": len(mesh_labels)},
       "disjointness": disj, "corpus_rows_seen": seen, "problems": problems}
json.dump(man, open(f"{OUT}/slices-manifest.json", "w"), indent=1)

print(json.dumps({k: v for k, v in man.items() if k != "counts"}, indent=1))
print("counts:", json.dumps(dict(counts), indent=1))
if problems:
    print("\nGATE FAILED:"); [print("  -", p) for p in problems]; sys.exit(1)
print("\nGATE PASSED")
