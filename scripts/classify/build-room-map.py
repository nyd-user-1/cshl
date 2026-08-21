#!/usr/bin/env python3
"""
LANE-LIBRARIAN — the room map.

A "room" is a scoped haystack a subject agent searches. The product bet (BEDROCK-KB-BAKEOFF,
and D9's curve when it exists) is that our stack wins inside small rooms, so every room must
come in under a size ceiling. Category alone does not achieve that: 18 of 76 categories exceed
10,000 papers and neuroscience is 62,183.

Splitting axis, in order of preference (the brief's "MeSH subtree first, year only as fallback"):
  1. MeSH tree facet, deepening until the room fits
  2. year band
  3. nothing else -- a room that still will not fit after 1 and 2 is REPORTED, not md5-shredded,
     because "Neuroscience - shard 3" is not a name a researcher recognises.

Check tags are excluded from the facet axis. The most frequent MeSH descriptors in this corpus
are Humans (56.6%), Animals (36.3%), Female (22.8%), Male (22.4%), Mice (15.2%) -- NLM check
tags describing the study population, not the subject. Faceting on them yields a "Humans" room
holding half the corpus. They live in MeSH tree M, under B01.050 (Animals), or carry no tree
number at all (Female, Male), so the exclusion is structural rather than a hand-written list.
"""
import json, os, sys, argparse
from collections import defaultdict, Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MINE = f"{ROOT}/data/mine"

ap = argparse.ArgumentParser()
ap.add_argument("--max-room", type=int, default=10000)
ap.add_argument("--predictions", default="")     # mesh.knnprop.jsonl.gz or mesh.predictions.jsonl.gz
ap.add_argument("--pred-field", default="top")   # 'top' = full ranked vector; 'predicted' = pre-thresholded
ap.add_argument("--pred-threshold", type=float, default=0.25)
ap.add_argument("--out", default=f"{ROOT}/data/classify/room-map.json")
ap.add_argument("--min-room", type=int, default=150)  # below this, merge back into the parent
A = ap.parse_args()

def log(*a): print("[rooms]", *a, flush=True)

# ---------------------------------------------------------------- MeSH tree
name, trees = {}, {}
for line in open(f"{MINE}/mesh_dict.jsonl"):
    d = json.loads(line)
    name[d["ui"]] = d["name"]; trees[d["ui"]] = d.get("tree_numbers") or []

def is_check_tag(ui):
    tn = trees.get(ui, [])
    if not tn: return True                                   # Female, Male: no tree at all
    return all(t.startswith("M") or t.startswith("B01.050") or t[0] in "VZ" for t in tn)

CHECK = {ui for ui in trees if is_check_tag(ui)}
log(f"mesh descriptors {len(trees)}, treated as check tags / non-topical: {len(CHECK)}")

# human-readable facet names, from the descriptor that OWNS the node (its whole tree number)
facet_name = {}
for ui, tn in trees.items():
    for t in tn:
        if ui not in CHECK: facet_name.setdefault(t, name[ui])

def facets_of(ui, depth):
    """tree prefixes at `depth` levels, e.g. depth 2 -> 'C04', depth 3 -> 'C04.588'."""
    out = set()
    for t in trees.get(ui, []):
        parts = t.split(".")
        if len(parts) >= depth: out.add(".".join(parts[:depth]))
        elif parts: out.add(".".join(parts))
    return out

def pretty(f):
    n = facet_name.get(f)
    if n: return n
    # walk up to the nearest named ancestor
    parts = f.split(".")
    while parts:
        parts.pop()
        cand = ".".join(parts)
        if cand in facet_name: return facet_name[cand] + " (broader)"
    return {"A":"Anatomy","B":"Organisms","C":"Diseases","D":"Chemicals & drugs",
            "E":"Techniques","F":"Psychiatry & psychology","G":"Phenomena & processes",
            "H":"Disciplines","I":"Society","J":"Technology & food","K":"Humanities",
            "L":"Information science","N":"Health care"}.get(f[0], f)

# ---------------------------------------------------------------- corpus + labels
log("reading corpus")
cat, year, labels = {}, {}, defaultdict(list)
for line in open(f"{MINE}/corpus-text.jsonl"):
    d = json.loads(line)
    cat[d["key"]] = d.get("category"); year[d["key"]] = d.get("year")

observed = set()
for line in open(f"{MINE}/mesh.jsonl"):
    d = json.loads(line)
    m = d.get("mesh") or []
    if m:
        observed.add(d["key"])
        labels[d["key"]] = [x["ui"] for x in m if isinstance(x, dict) and "ui" in x]

n_pred = 0
if A.predictions:
    import gzip
    op = gzip.open if A.predictions.endswith(".gz") else open
    for line in op(A.predictions, "rt"):
        d = json.loads(line)
        if d["slug"] in observed: continue      # never overwrite ground truth
        cand = d.get(A.pred_field) or d.get("predicted") or []
        keep = [x["ui"] for x in cand if x.get("p", 1.0) >= A.pred_threshold]
        if not keep and cand: keep = [cand[0]["ui"]]   # never leave a paper label-less if we have any signal
        labels[d["slug"]] = keep
        n_pred += 1
log(f"papers {len(cat)}  observed-mesh {len(observed)}  predicted-mesh {n_pred}")

by_cat = defaultdict(list)
for k, c in cat.items(): by_cat[c or "__NO_CATEGORY__"].append(k)

# ---------------------------------------------------------------- the split
def split(papers, depth, max_depth=5):
    """Partition `papers` by their primary MeSH facet at `depth`. Each paper lands in exactly
    one facet -- rooms are a partition, so 'papers without a room' is a meaningful count."""
    freq = Counter()
    pf = {}
    for p in papers:
        fs = set()
        for ui in labels.get(p, []):
            if ui in CHECK: continue
            fs |= facets_of(ui, depth)
        pf[p] = fs; freq.update(fs)
    groups = defaultdict(list)
    for p in papers:
        fs = pf[p]
        if not fs: groups["__NO_FACET__"].append(p)
        else:      groups[max(fs, key=lambda f: (freq[f], f))].append(p)
    return groups

import re
_DATED = re.compile(r"^(\d{4})\.(\d{2})\.")
def _period(p, halves):
    """Time key. bioRxiv/medRxiv slugs from 2020 on encode the submission date
    (2024.04.07.24305438), so a year band that is still too big can be halved into
    something a reader still recognises -- '2025 H1' -- rather than shredded by md5."""
    m = _DATED.match(p)
    if halves and m:
        return (int(m.group(1)), 1 if int(m.group(2)) <= 6 else 2)
    return (year.get(p) or 0, 0)

def by_year(papers, halves=False):
    g = defaultdict(list)
    for p in papers: g[_period(p, halves)].append(p)
    bands, cur, lo = [], [], None
    for k in sorted(g):
        if lo is None: lo = k
        cur += g[k]
        if len(cur) >= A.max_room * 0.75:
            bands.append(((lo, k), cur)); cur, lo = [], None
    if cur: bands.append(((lo, max(g)), cur))
    return bands

def time_bands(papers):
    """Year bands; any band still over the ceiling is retried at half-year resolution."""
    out, over = [], []
    for k, band in by_year(papers, halves=False):
        (out if len(band) <= A.max_room else over).append((k, band))
    for k, band in over:
        for k2, b2 in by_year(band, halves=True):
            out.append((k2, b2))
    return out

def fmt_span(span):
    def one(k):
        y, h = (k if isinstance(k, (list, tuple)) else (k, 0))
        return f"{y} H{h}" if h else f"{y}"
    a, b = one(span[0]), one(span[1])
    return a if a == b else f"{a}\u2013{b}"

def build(category, papers):
    rooms, unplaced = [], []
    def rec(ps, depth, path):
        if len(ps) <= A.max_room:
            rooms.append({"axis": "mesh" if path else "category", "facet": path,
                          "label": pretty(path) if path else None, "papers": ps}); return
        if depth > 5:
            for (lo, hi), band in time_bands(ps):
                if len(band) <= A.max_room:
                    rooms.append({"axis": "year", "facet": path, "label": pretty(path) if path else None,
                                  "years": [lo, hi], "papers": band})
                else:
                    unplaced.append({"facet": path, "years": [lo, hi], "n": len(band), "papers": band})
            return
        groups = split(ps, depth)
        nf = groups.pop("__NO_FACET__", [])
        # a facet that captured essentially everything cannot split -- go deeper on it directly
        for f, g in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            rec(g, depth + 1, f)
        if nf:
            if len(nf) <= A.max_room:
                rooms.append({"axis": "no-mesh-facet", "facet": path,
                              "label": (pretty(path) + " · " if path else "") + "unclassified", "papers": nf})
            else:
                for (lo, hi), band in time_bands(nf):
                    if len(band) <= A.max_room:
                        rooms.append({"axis": "year", "facet": path,
                                      "label": (pretty(path) + " · " if path else "") + "unclassified",
                                      "years": [lo, hi], "papers": band})
                    else:
                        unplaced.append({"facet": path or category, "years": [lo, hi], "n": len(band), "papers": band})
    rec(papers, 2, "")
    return rooms, unplaced

placed_hint = len(cat)
log(f"building rooms, ceiling {A.max_room}")
all_rooms, all_unplaced = [], []
for c, ps in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
    rooms, unplaced = build(c, ps)
    # merge slivers back so we do not ship 40-paper "rooms"
    small = [r for r in rooms if len(r["papers"]) < A.min_room]
    big = [r for r in rooms if len(r["papers"]) >= A.min_room]
    if small:
        merged = [p for r in small for p in r["papers"]]
        target = min(big, key=lambda r: len(r["papers"])) if big else None
        if target and len(target["papers"]) + len(merged) <= A.max_room:
            target["papers"] += merged
        else:
            big.append({"axis": "residual", "facet": "", "label": "other", "papers": merged})
        rooms = big
    for r in rooms:
        r["category"] = c
        r["name"] = (c.title() if c != "__NO_CATEGORY__" else "Uncategorised") + \
                    (f" · {r['label']}" if r.get("label") else "") + \
                    (f" ({fmt_span(r['years'])})" if r.get("years") else "")
    # Disambiguate collisions. Several distinct tree nodes can resolve to the same nearest
    # named ancestor, which produced three separate rooms all called "Neuroscience · Neurons"
    # -- unusable in a navigation UI. Distinguish them by the descriptor that most
    # distinguishes each room from its namesakes, not by a shard number.
    seen = Counter(r["name"] for r in rooms)
    dupes = {n for n, k in seen.items() if k > 1}
    for dn in dupes:
        grp = [r for r in rooms if r["name"] == dn]
        prof = []
        for r in grp:
            c2 = Counter()
            for p in r["papers"]:
                for ui in labels.get(p, []):
                    if ui not in CHECK: c2[ui] += 1
            prof.append((c2, max(len(r["papers"]), 1)))
        for i, r in enumerate(grp):
            mine, n_mine = prof[i]
            others = Counter(); n_oth = 0
            for j, (c2, n2) in enumerate(prof):
                if j != i: others += c2; n_oth += n2
            n_oth = max(n_oth, 1)
            # the descriptor this room has that its namesakes do NOT -- a name a reader can act on
            cand = [(ui, mine[ui] / n_mine - others[ui] / n_oth) for ui in mine
                    if mine[ui] >= 5 and name.get(ui, "").lower() not in dn.lower()]
            if cand:
                best = max(cand, key=lambda kv: kv[1])[0]
                r["name"] = f"{dn} — {name[best].lower()}"
            else:
                r["name"] = f"{dn} [{r['facet']}]"
    all_rooms += rooms
    for u in unplaced: u["category"] = c
    all_unplaced += unplaced

placed = sum(len(r["papers"]) for r in all_rooms)
unpl = sum(u["n"] for u in all_unplaced)

# ---------------------------------------------------------------- rooms vs shards
# A ROOM is what a user picks: always topical, always choosable.
# A SHARD is what the index holds. THE CEILING GOVERNS SHARDS, NOT ROOMS.
#
# Why: the first version made the year band part of the room name, which produced four
# "Neuroscience · Brain" rooms distinguished only by date. Navigation is the router, and a
# user's question has no date -- so they cannot choose correctly, and a route the user has no
# basis for choosing fails INVISIBLY, which is the failure the scoped architecture exists to
# prevent. Year bands were never wrong as a sharding strategy, only as a naming one.
# Picking "Neuroscience · Brain" searches all four of its shards; the haystack the user is
# confined to is the room, and each shard stays under the ceiling.
rooms_by_key = defaultdict(list)
for r in all_rooms:
    base = r["name"].split(" (")[0]          # drop the year span from the user-facing name
    rooms_by_key[(r["category"], base)].append(r)

rooms_out = []
for (c, base), shards in rooms_by_key.items():
    shards.sort(key=lambda r: -len(r["papers"]))
    n = sum(len(r["papers"]) for r in shards)
    rooms_out.append({
        "name": base, "category": c, "n": n, "shards": len(shards),
        "axis": shards[0]["axis"] if len(shards) == 1 else "mesh+year-shards",
        "n_predicted_labels": sum(1 for r in shards for p in r["papers"] if p not in observed),
        "shard_detail": [{"n": len(r["papers"]), "axis": r["axis"],
                          "years": r.get("years"), "name": r["name"]} for r in shards],
    })
rooms_out.sort(key=lambda r: (r["category"], -r["n"]))

shard_sizes = sorted((len(r["papers"]) for r in all_rooms), reverse=True)
room_sizes = sorted((r["n"] for r in rooms_out), reverse=True)
log(f"shards {len(all_rooms)}  ROOMS {len(rooms_out)}  placed {placed}  unplaced {unpl}  total {placed+unpl} (corpus {len(cat)})")
log(f"largest shard {shard_sizes[0]}  shards over ceiling: {sum(1 for s in shard_sizes if s > A.max_room)}")
log(f"largest room {room_sizes[0]}  multi-shard rooms: {sum(1 for r in rooms_out if r['shards'] > 1)}")

out = {"max_room": A.max_room, "min_room": A.min_room,
       "ceiling_governs": "shards",
       "predictions_used": bool(A.predictions), "n_predicted": n_pred,
       "corpus": len(cat), "placed": placed, "unplaced": unpl,
       "n_shards": len(all_rooms),
       "rooms": rooms_out,
       "unplaced_groups": [{k: v for k, v in u.items() if k != "papers"} for u in all_unplaced]}
json.dump(out, open(A.out, "w"), indent=1)
with open(A.out.replace(".json", ".members.jsonl"), "w") as w:
    for r in all_rooms:
        w.write(json.dumps({"room": r["name"].split(" (")[0], "shard": r["name"],
                            "slugs": r["papers"]}) + "\n")
log(f"wrote {A.out}")
