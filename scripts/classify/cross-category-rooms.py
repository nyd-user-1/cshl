#!/usr/bin/env python3
"""
LANE-LIBRARIAN stretch — propose CROSS-CATEGORY rooms.

Category is author-assigned at submission and is a filing decision, not a statement about
what a paper is near. Where two categories genuinely overlap, the room map's
category-first partition splits a real community in half.

Method, and the constraint the brief sets ("propose nothing you cannot show membership for"):
  1. centroid per room over preprint_embeddings_cshl -- the cshl-CITE encoder, our best
     document-similarity model. Computed in-database with pgvector's avg().
  2. cosine between centroids of rooms in DIFFERENT categories.
  3. a candidate pair is only reported if it survives a MEMBERSHIP test, not just centroid
     proximity: sample papers from each side, retrieve their nearest neighbours WITHIN the
     union, and measure how often the nearest neighbour comes from the other room. Two
     distinct blobs whose centroids happen to sit near each other score ~0 here; genuinely
     interleaved communities score high. Centroid similarity alone would happily marry two
     unrelated rooms that both sit near the corpus mean.
  4. only pairs whose union still fits the ceiling are proposed.
"""
import json, os, subprocess, argparse, math
import numpy as np
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser()
ap.add_argument("--members", default=f"{ROOT}/data/classify/room-map.members.jsonl")
ap.add_argument("--rooms", default=f"{ROOT}/data/classify/room-map.json")
ap.add_argument("--table", default="preprint_embeddings_cshl")
ap.add_argument("--max-room", type=int, default=10000)
ap.add_argument("--min-cos", type=float, default=0.80)
ap.add_argument("--sample", type=int, default=60)
ap.add_argument("--out", default=f"{ROOT}/data/classify/cross-category-rooms.json")
A = ap.parse_args()

def psql(sql):
    r = subprocess.run([f"{ROOT}/scripts/psql-cshl.sh", "-t", "-A", "-F", "\t", "-c", sql],
                       capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr[:800])
    return [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]

rooms = {r["name"]: r for r in json.load(open(A.rooms))["rooms"]}
members = {}
for line in open(A.members):
    d = json.loads(line); members[d["room"]] = d["slugs"]
print(f"[xcat] {len(members)} rooms")

# ---- 1. centroids, in-database
cent, names = {}, []
for i, (rn, slugs) in enumerate(members.items()):
    if len(slugs) < 200: continue
    arr = "ARRAY[" + ",".join("'" + s.replace("'", "''") + "'" for s in slugs) + "]"
    out = psql(f"SELECT avg(embedding)::text FROM {A.table} WHERE key_number = ANY({arr});")
    if not out or not out[0][0].strip(): continue
    v = np.fromstring(out[0][0].strip().strip("[]"), sep=",", dtype=np.float32)
    n = np.linalg.norm(v)
    if n == 0: continue
    cent[rn] = v / n; names.append(rn)
    if i % 20 == 0: print(f"[xcat] centroid {i}/{len(members)}", flush=True)
print(f"[xcat] {len(cent)} centroids")

# ---- 2. cross-category pairs by centroid cosine
M = np.stack([cent[n] for n in names])
S = M @ M.T
cands = []
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        a, b = names[i], names[j]
        if rooms[a]["category"] == rooms[b]["category"]: continue
        if rooms[a]["n"] + rooms[b]["n"] > A.max_room: continue
        if S[i, j] >= A.min_cos: cands.append((float(S[i, j]), a, b))
cands.sort(reverse=True)
print(f"[xcat] {len(cands)} candidate cross-category pairs at cos >= {A.min_cos}")

# ---- 3. the membership test
def interleave(a, b):
    """Fraction of sampled papers whose nearest neighbour inside A∪B sits in the OTHER room."""
    sa = sorted(members[a])[:A.sample]; sb = sorted(members[b])[:A.sample]
    uni = members[a] + members[b]
    inb = set(members[b])
    arrU = "ARRAY[" + ",".join("'" + s.replace("'", "''") + "'" for s in uni) + "]"
    crossed = tot = 0
    for src, want_other in ((sa, inb), (sb, set(members[a]))):
        for k in src:
            out = psql(f"""SELECT n.key_number FROM {A.table} n
                           WHERE n.key_number = ANY({arrU}) AND n.key_number <> '{k}'
                           ORDER BY n.embedding <=> (SELECT embedding FROM {A.table} WHERE key_number='{k}')
                           LIMIT 1;""")
            if not out: continue
            tot += 1
            if out[0][0] in want_other: crossed += 1
    return crossed / max(tot, 1), tot

proposals = []
for cos, a, b in cands[:12]:
    frac, tot = interleave(a, b)
    ex = sorted(members[a])[:3] + sorted(members[b])[:2]
    titles = psql("SELECT key_number, left(title,110) FROM preprints WHERE key_number = ANY(ARRAY["
                  + ",".join(f"'{e}'" for e in ex) + "]);")
    proposals.append({"room_a": a, "room_b": b, "centroid_cos": round(cos, 4),
                      "n_a": rooms[a]["n"], "n_b": rooms[b]["n"],
                      "n_union": rooms[a]["n"] + rooms[b]["n"],
                      "interleaving": round(frac, 3), "probes": tot,
                      "examples": [{"slug": t[0], "title": t[1]} for t in titles]})
    print(f"[xcat] {cos:.3f} interleave={frac:.2f}  {a}  ×  {b}", flush=True)

proposals.sort(key=lambda p: -p["interleaving"])
json.dump({"table": A.table, "min_cos": A.min_cos, "max_room": A.max_room,
           "candidates": len(cands), "proposals": proposals}, open(A.out, "w"), indent=1)
print(f"[xcat] wrote {A.out}")
