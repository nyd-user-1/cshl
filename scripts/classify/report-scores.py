#!/usr/bin/env python3
"""Render the scored comparison table from the box's JSONs.

Three arms per task, so the trained number means something:
  prior  -- majority class / global label prior. Reads no text. The floor.
  kNN    -- k-nearest-neighbour over the STOCK bge-m3 embeddings we already have.
            The one that decides whether the model is worth serving: a classifier that
            cannot beat a kNN lookup over embeddings we already pay to store is not a
            product, it is a liability.
  model  -- the fine-tune.
"""
import json, os, argparse
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser()
ap.add_argument("--dir", default=f"{ROOT}/data/classify/scores")
ap.add_argument("--out", default="")
A = ap.parse_args()

def load(n):
    p = f"{A.dir}/{n}"
    return json.load(open(p)) if os.path.exists(p) else None

L = []
w = L.append
for task, title in [("category", "cshl-category"), ("mesh", "cshl-MESH-tagger")]:
    arms = [("prior (reads no text)", load(f"{task}.baseline-prior.json")),
            ("kNN over stock bge-m3", load(f"{task}.baseline-knn.json")),
            (f"**{title}**", load(f"{task}.scores.json"))]
    if not any(a[1] for a in arms):
        w(f"### {title} — no scores present"); w(""); continue
    w(f"### {title}")
    w("")
    for split, sn in [("test", "held-out test split"), ("eval", "frozen `cshl-eval-v1` 10k")]:
        rows = [(n, d[split]) for n, d in arms if d and split in d]
        if not rows: continue
        n_q = rows[0][1].get("n")
        w(f"**{sn}** (n={n_q:,})")
        w("")
        if task == "category":
            w("| arm | accuracy | macro F1 |")
            w("|---|---|---|")
            for n, r in rows:
                w(f"| {n} | {r['accuracy']*100:.2f}% | {r['macro_f1']*100:.2f}% |")
        else:
            keys = ["micro_f1", "macro_f1_on_occurring", "P@5", "P@10", "R@10", "R@15"]
            w("| arm | " + " | ".join(k.replace("_", " ") for k in keys) + " |")
            w("|---|" + "---|" * len(keys))
            for n, r in rows:
                w(f"| {n} | " + " | ".join(f"{r.get(k,0)*100:.2f}" for k in keys) + " |")
        w("")
    m = load(f"{task}.scores.json")
    if task == "category" and m and "test" in m and m["test"].get("top_confusions"):
        w("Top confusions on test (`gold -> predicted`):")
        w("")
        w("| confusion | n |")
        w("|---|---|")
        for c, k in m["test"]["top_confusions"][:12]: w(f"| {c} | {k} |")
        w("")
    if task == "mesh" and m and "test" in m:
        r = m["test"]
        w(f"Label budget: predicts **{r.get('mean_predicted_labels',0):.2f}** descriptors/paper "
          f"against **{r.get('mean_gold_labels',0):.2f}** observed; "
          f"{r.get('labels_occurring',0):,} of the label space occur in this split.")
        w("")
out = "\n".join(L) + "\n"
print(out)
if A.out: open(A.out, "w").write(out)
