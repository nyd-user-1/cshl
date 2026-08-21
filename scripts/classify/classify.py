#!/usr/bin/env python3
"""
LANE-LIBRARIAN box-side worker: cshl-MESH-tagger + cshl-category.

Subcommands
  train  --task {mesh,category}   fine-tune, eval on val each epoch, keep best
  score  --task {mesh,category}   score the UNTOUCHED test split + the frozen eval set
  infer  --task mesh              tag the corpus rows with no observed MeSH
  knn    --task {mesh,category}   the trivial baseline: kNN over STOCK bge-m3 embeddings

Why ModernBERT-base: embed_text is capped at 4000 chars (~900-1000 tokens). A BERT-family
512-token encoder would truncate roughly half of every long abstract, so the classifier
would see less of the paper than the retrieval encoder does. ModernBERT handles 1024
comfortably and its unpadding makes the longer window close to free on this length mix.
"""
import argparse, json, os, sys, time, math
import numpy as np

def log(*a): print("[classify]", *a, flush=True)

def read_jsonl(p, limit=None):
    out = []
    with open(p) as f:
        for i, line in enumerate(f):
            if limit and i >= limit: break
            out.append(json.loads(line))
    return out

# --------------------------------------------------------------------------- train
def cmd_train(a):
    import torch
    from torch.utils.data import Dataset
    from transformers import (AutoTokenizer, AutoModelForSequenceClassification,
                              TrainingArguments, Trainer, DataCollatorWithPadding)

    labels = json.load(open(f"{a.data}/{a.task}.labels.json"))["labels"]
    nlab = len(labels)
    multi = a.task == "mesh"
    tr = read_jsonl(f"{a.data}/{a.task}.train.jsonl", a.limit)
    va = read_jsonl(f"{a.data}/{a.task}.val.jsonl", a.limit)
    log(f"task={a.task} labels={nlab} train={len(tr)} val={len(va)} multi_label={multi}")

    tok = AutoTokenizer.from_pretrained(a.base, cache_dir=a.cache)
    class DS(Dataset):
        def __init__(s, rows): s.rows = rows
        def __len__(s): return len(s.rows)
        def __getitem__(s, i):
            r = s.rows[i]
            e = tok(r["text"], truncation=True, max_length=a.max_len)
            if multi:
                y = np.zeros(nlab, dtype=np.float32); y[r["y"]] = 1.0
                e["labels"] = y
            else:
                e["labels"] = int(r["y"])
            return e

    model = AutoModelForSequenceClassification.from_pretrained(
        a.base, num_labels=nlab, cache_dir=a.cache,
        problem_type="multi_label_classification" if multi else "single_label_classification")

    def metrics(p):
        logits = p.predictions[0] if isinstance(p.predictions, tuple) else p.predictions
        y = p.label_ids
        if multi:
            pred = (1 / (1 + np.exp(-logits))) >= 0.5
            tp = (pred & (y > 0.5)).sum(); fp = (pred & (y < 0.5)).sum(); fn = ((~pred) & (y > 0.5)).sum()
            micro = 2 * tp / max(2 * tp + fp + fn, 1)
            return {"micro_f1": float(micro)}
        return {"accuracy": float((logits.argmax(-1) == y).mean())}

    args = TrainingArguments(
        output_dir=a.out, overwrite_output_dir=True,
        num_train_epochs=a.epochs, per_device_train_batch_size=a.batch,
        per_device_eval_batch_size=a.batch * 2, learning_rate=a.lr,
        warmup_ratio=0.06, weight_decay=0.01, bf16=True,
        logging_steps=50, eval_strategy="epoch", save_strategy="steps",
        save_steps=a.save_steps, save_total_limit=3,
        load_best_model_at_end=False, dataloader_num_workers=4,
        # group_by_length is load-bearing on cost, not a nicety. Without flash-attn the
        # ModernBERT path pads each batch to ITS max, and with random shuffling that max
        # sits near max_len (1024) on nearly every batch -- so a corpus averaging ~430
        # tokens would be billed at ~1024. Grouping by length makes the padded cost track
        # the mean instead. It costs one upfront tokenizing pass (~90s over 260k rows).
        group_by_length=True,
        report_to=[],
    )
    trainer = Trainer(model=model, args=args, train_dataset=DS(tr), eval_dataset=DS(va),
                      data_collator=DataCollatorWithPadding(tok), compute_metrics=metrics)
    t0 = time.time()
    trainer.train(resume_from_checkpoint=a.resume or None)
    dt = time.time() - t0
    log(f"train wall-clock {dt:.0f}s")
    trainer.save_model(f"{a.out}/final"); tok.save_pretrained(f"{a.out}/final")
    json.dump({"labels": labels, "multi_label": multi, "base": a.base,
               "max_len": a.max_len, "epochs": a.epochs, "batch": a.batch,
               "train_rows": len(tr), "wall_clock_s": round(dt)},
              open(f"{a.out}/final/label_config.json", "w"))
    log(f"saved {a.out}/final")

# ------------------------------------------------------------------- predict helper
def _predict(model_dir, rows, max_len, batch, want_logits=True):
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    tok = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(model_dir).cuda().eval().to(torch.bfloat16)
    out = []
    # length-sorted batching: ModernBERT unpads, so grouping similar lengths cuts
    # padding waste hard on a corpus whose abstracts vary 200-4000 chars.
    order = sorted(range(len(rows)), key=lambda i: -len(rows[i]["text"]))
    with torch.no_grad():
        for s in range(0, len(order), batch):
            idx = order[s:s + batch]
            enc = tok([rows[i]["text"] for i in idx], truncation=True, max_length=max_len,
                      padding=True, return_tensors="pt").to("cuda")
            lg = model(**enc).logits.float().cpu().numpy()
            out.append((idx, lg))
            if (s // batch) % 200 == 0: log(f"  predict {s}/{len(order)}")
    res = [None] * len(rows)
    for idx, lg in out:
        for j, i in enumerate(idx): res[i] = lg[j]
    return np.stack(res)

# --------------------------------------------------------------------------- score
def _mesh_metrics(logits, gold_sets, nlab, ks=(5, 10, 15)):
    prob = 1 / (1 + np.exp(-logits))
    pred = prob >= 0.5
    Y = np.zeros_like(pred)
    for i, g in enumerate(gold_sets): Y[i, list(g)] = True
    tp = (pred & Y).sum(); fp = (pred & ~Y).sum(); fn = (~pred & Y).sum()
    micro = 2 * tp / max(2 * tp + fp + fn, 1)
    # macro over labels that actually occur in this eval set
    occ = Y.sum(0) > 0
    ltp = (pred & Y).sum(0)[occ]; lfp = (pred & ~Y).sum(0)[occ]; lfn = (~pred & Y).sum(0)[occ]
    macro = float(np.mean(2 * ltp / np.maximum(2 * ltp + lfp + lfn, 1)))
    out = {"micro_f1": float(micro), "macro_f1_on_occurring": macro,
           "labels_occurring": int(occ.sum()),
           "mean_predicted_labels": float(pred.sum(1).mean()),
           "mean_gold_labels": float(Y.sum(1).mean())}
    topk = np.argsort(-logits, axis=1)
    for k in ks:
        hits = [len(set(topk[i, :k].tolist()) & gold_sets[i]) for i in range(len(gold_sets))]
        out[f"P@{k}"] = float(np.mean([h / k for h in hits]))
        out[f"R@{k}"] = float(np.mean([h / max(len(gold_sets[i]), 1) for i, h in enumerate(hits)]))
    return out

def _cat_metrics(logits, gold, labels):
    pred = logits.argmax(1)
    acc = float((pred == np.array(gold)).mean())
    nlab = len(labels)
    f1s = []
    for c in range(nlab):
        tp = int(((pred == c) & (np.array(gold) == c)).sum())
        fp = int(((pred == c) & (np.array(gold) != c)).sum())
        fn = int(((pred != c) & (np.array(gold) == c)).sum())
        if tp + fn > 0: f1s.append(2 * tp / max(2 * tp + fp + fn, 1))
    conf = {}
    for g, p in zip(gold, pred):
        if g != p: conf[f"{labels[g]} -> {labels[p]}"] = conf.get(f"{labels[g]} -> {labels[p]}", 0) + 1
    top_conf = sorted(conf.items(), key=lambda kv: -kv[1])[:15]
    return {"accuracy": acc, "macro_f1": float(np.mean(f1s)), "classes_present": len(f1s),
            "top_confusions": top_conf}

def cmd_score(a):
    cfg = json.load(open(f"{a.model}/label_config.json"))
    labels = cfg["labels"]; multi = cfg["multi_label"]
    res = {}
    for split in ["test", "eval"]:
        rows = read_jsonl(f"{a.data}/{a.task}.{split}.jsonl", a.limit)
        if not rows: continue
        lg = _predict(a.model, rows, cfg["max_len"], a.batch)
        if multi:
            res[split] = _mesh_metrics(lg, [set(r["y"]) for r in rows], len(labels))
        else:
            res[split] = _cat_metrics(lg, [r["y"] for r in rows], labels)
        res[split]["n"] = len(rows)
        log(f"{a.task}/{split}: {json.dumps({k:v for k,v in res[split].items() if k!='top_confusions'})}")
    json.dump(res, open(f"{a.out}/{a.task}.scores.json", "w"), indent=1)

# ----------------------------------------------------------------- trivial baselines
def cmd_baseline(a):
    """majority / prior baseline -- no GPU, no DB. The floor any model must clear."""
    labels = json.load(open(f"{a.data}/{a.task}.labels.json"))["labels"]
    tr = read_jsonl(f"{a.data}/{a.task}.train.jsonl")
    res = {}
    for split in ["test", "eval"]:
        rows = read_jsonl(f"{a.data}/{a.task}.{split}.jsonl")
        if not rows: continue
        if a.task == "category":
            from collections import Counter
            maj = Counter(r["y"] for r in tr).most_common(1)[0][0]
            lg = np.full((len(rows), len(labels)), -1e9, dtype=np.float32); lg[:, maj] = 1.0
            res[split] = _cat_metrics(lg, [r["y"] for r in rows], labels)
            res[split]["strategy"] = f"always predict '{labels[maj]}'"
        else:
            df = np.zeros(len(labels))
            for r in tr:
                for y in r["y"]: df[y] += 1
            df /= len(tr)
            # predict the globally most frequent descriptors: threshold at prior>=0.5,
            # ranking by prior for P@k. This is the "no text read at all" floor.
            lg = np.tile(np.log(np.maximum(df, 1e-9) / np.maximum(1 - df, 1e-9)), (len(rows), 1)).astype(np.float32)
            res[split] = _mesh_metrics(lg, [set(r["y"]) for r in rows], len(labels))
            res[split]["strategy"] = "global label prior (reads no text)"
        res[split]["n"] = len(rows)
        log(f"BASELINE-prior {a.task}/{split}: {json.dumps({k:v for k,v in res[split].items() if k!='top_confusions'})}")
    json.dump(res, open(f"{a.out}/{a.task}.baseline-prior.json", "w"), indent=1)

def cmd_knn(a):
    """kNN over STOCK bge-m3 embeddings (preprint_embeddings). The baseline that matters:
    a trained classifier that cannot beat it is not worth serving."""
    import psycopg2, torch
    labels = json.load(open(f"{a.data}/{a.task}.labels.json"))["labels"]
    tr = read_jsonl(f"{a.data}/{a.task}.train.jsonl")
    if a.knn_pool and len(tr) > a.knn_pool:
        keep = sorted(range(len(tr)), key=lambda i: tr[i]["slug"])[:a.knn_pool]
        tr = [tr[i] for i in keep]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    def fetch(slugs):
        vecs = {}
        cur = conn.cursor()
        for s in range(0, len(slugs), 2000):
            chunk = slugs[s:s + 2000]
            cur.execute("SELECT key_number, embedding::text FROM preprint_embeddings WHERE key_number = ANY(%s)", (chunk,))
            for k, v in cur.fetchall():
                vecs[k] = np.fromstring(v.strip("[]"), sep=",", dtype=np.float32)
            if (s // 2000) % 20 == 0: log(f"  fetched {len(vecs)}/{len(slugs)}")
        cur.close()
        return vecs
    log(f"kNN baseline: pool={len(tr)}")
    pv = fetch([r["slug"] for r in tr])
    tr = [r for r in tr if r["slug"] in pv]
    P = torch.tensor(np.stack([pv[r["slug"]] for r in tr])).cuda()
    P = torch.nn.functional.normalize(P, dim=1)
    res = {}
    for split in ["test", "eval"]:
        rows = read_jsonl(f"{a.data}/{a.task}.{split}.jsonl")
        if a.knn_queries and len(rows) > a.knn_queries:
            rows = sorted(rows, key=lambda r: r["slug"])[:a.knn_queries]
        qv = fetch([r["slug"] for r in rows])
        rows = [r for r in rows if r["slug"] in qv]
        Q = torch.nn.functional.normalize(torch.tensor(np.stack([qv[r["slug"]] for r in rows])).cuda(), dim=1)
        K = a.k
        idx = []
        for s in range(0, len(Q), 1024):
            sim = Q[s:s + 1024] @ P.T
            idx.append(sim.topk(K, dim=1).indices.cpu().numpy())
        idx = np.concatenate(idx)
        if a.task == "category":
            lg = np.zeros((len(rows), len(labels)), dtype=np.float32)
            for i in range(len(rows)):
                for j in idx[i]: lg[i, tr[j]["y"]] += 1.0
            res[split] = _cat_metrics(lg, [r["y"] for r in rows], labels)
        else:
            lg = np.full((len(rows), len(labels)), -6.0, dtype=np.float32)
            for i in range(len(rows)):
                for j in idx[i]:
                    for y in tr[j]["y"]: lg[i, y] += 12.0 / K
            res[split] = _mesh_metrics(lg, [set(r["y"]) for r in rows], len(labels))
        res[split].update({"n": len(rows), "k": K, "pool": len(tr),
                           "strategy": f"kNN k={K} over stock bge-m3 preprint_embeddings"})
        log(f"BASELINE-knn {a.task}/{split}: {json.dumps({k:v for k,v in res[split].items() if k!='top_confusions'})}")
    json.dump(res, open(f"{a.out}/{a.task}.baseline-knn.json", "w"), indent=1)

# --------------------------------------------------------------------------- infer
def cmd_infer(a):
    cfg = json.load(open(f"{a.model}/label_config.json"))
    labels = cfg["labels"]
    desc = json.load(open(f"{a.data}/mesh.labels.json"))["descriptors"]
    rows = read_jsonl(f"{a.data}/mesh.infer.jsonl", a.limit)
    log(f"inferring MeSH for {len(rows)} rows with no observed MeSH")
    lg = _predict(a.model, rows, cfg["max_len"], a.batch)
    prob = 1 / (1 + np.exp(-lg))
    topk = np.argsort(-prob, axis=1)[:, :a.top_k]
    n_thresh = 0
    with open(f"{a.out}/mesh.predictions.jsonl", "w") as w:
        for i, r in enumerate(rows):
            sel = [int(j) for j in topk[i] if prob[i, j] >= a.threshold]
            n_thresh += len(sel)
            w.write(json.dumps({
                "slug": r["slug"], "category": r.get("category"), "year": r.get("year"),
                "server": r.get("server"), "mesh_provenance": r.get("mesh_provenance"),
                "predicted": [{"ui": labels[j], "descriptor": desc[j], "p": round(float(prob[i, j]), 4)}
                              for j in sel],
                "top": [{"ui": labels[int(j)], "descriptor": desc[int(j)], "p": round(float(prob[i, int(j)]), 4)}
                        for j in topk[i][:5]],
            }) + "\n")
    log(f"wrote {len(rows)} predictions, mean {n_thresh/max(len(rows),1):.2f} labels >= {a.threshold}")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["train", "score", "infer", "knn", "baseline"])
    p.add_argument("--task", default="category")
    p.add_argument("--data", default="/opt/classify/data")
    p.add_argument("--out", default="/opt/classify/out")
    p.add_argument("--model", default="")
    p.add_argument("--base", default="answerdotai/ModernBERT-base")
    p.add_argument("--cache", default="/opt/classify/hf-cache")
    p.add_argument("--max-len", dest="max_len", type=int, default=1024)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--epochs", type=float, default=2)
    p.add_argument("--lr", type=float, default=3e-5)
    p.add_argument("--save-steps", dest="save_steps", type=int, default=500)
    p.add_argument("--resume", default="")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--k", type=int, default=15)
    p.add_argument("--knn-pool", dest="knn_pool", type=int, default=100000)
    p.add_argument("--knn-queries", dest="knn_queries", type=int, default=5000)
    p.add_argument("--top-k", dest="top_k", type=int, default=20)
    p.add_argument("--threshold", type=float, default=0.5)
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    {"train": cmd_train, "score": cmd_score, "infer": cmd_infer,
     "knn": cmd_knn, "baseline": cmd_baseline}[a.cmd](a)
