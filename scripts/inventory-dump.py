"""
Ground-truth inventory of the NSR JSON dump.

Sweeps every entry file in data/nsr/entries/**/ and aggregates field coverage,
so schema and loader decisions are made from the actual corpus rather than
sampled records. Writes a JSON summary to data/inventory.json.
"""

import json
import os
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

ENTRIES_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "nsr", "entries")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "inventory.json")


def scan_year_dir(year_dir):
    c = Counter()
    ref_types = Counter()
    per_year = Counter()
    for fn in os.listdir(year_dir):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(year_dir, fn)) as fh:
            r = json.load(fh)
        c["total"] += 1
        per_year[r.get("publicationYear")] += 1
        ref_types[r.get("referenceType") or "NONE"] += 1
        if r.get("doi"):
            c["doi"] += 1
        if r.get("title"):
            c["title"] += 1
        if r.get("authors"):
            c["authors"] += 1
        if r.get("collaborations"):
            c["collaborations"] += 1
        if r.get("sentenceGroups"):
            c["sentence_groups"] += 1
        if r.get("selectorGroups"):
            c["selector_groups"] += 1
        if r.get("nuclideSelectors"):
            c["nuclide_selectors"] += 1
        if r.get("reactionSelectors"):
            c["reaction_selectors"] += 1
        if r.get("subjectSelectors"):
            c["subject_selectors"] += 1
        if r.get("exforKeys"):
            c["exfor_keys"] += 1
        if r.get("pdfAvailable"):
            c["pdf_available"] += 1
        if r.get("xundlAvailable"):
            c["xundl_available"] += 1
        if r.get("errataEntries"):
            c["errata"] += 1
        if not r.get("isPrimary", True):
            c["non_primary"] += 1
        if "-E" in fn:
            c["erratum_files"] += 1
    return c, ref_types, per_year


def main():
    year_dirs = sorted(
        os.path.join(ENTRIES_DIR, d)
        for d in os.listdir(ENTRIES_DIR)
        if os.path.isdir(os.path.join(ENTRIES_DIR, d))
    )
    totals = Counter()
    ref_types = Counter()
    per_year = Counter()
    with ProcessPoolExecutor(max_workers=8) as pool:
        for c, rt, py in pool.map(scan_year_dir, year_dirs):
            totals += c
            ref_types += rt
            per_year += py

    n = totals["total"]
    summary = {
        "total_entries": n,
        "coverage_pct": {
            k: round(100.0 * totals[k] / n, 1)
            for k in sorted(totals)
            if k != "total"
        },
        "coverage_counts": dict(totals),
        "reference_types": dict(ref_types.most_common()),
        "per_decade": {},
    }
    for year, cnt in per_year.items():
        if year is None:
            continue
        decade = f"{(year // 10) * 10}s"
        summary["per_decade"][decade] = summary["per_decade"].get(decade, 0) + cnt
    summary["per_decade"] = dict(sorted(summary["per_decade"].items()))
    summary["per_year"] = {str(k): v for k, v in sorted(per_year.items()) if k}

    with open(OUT_PATH, "w") as fh:
        json.dump(summary, fh, indent=2)

    print(json.dumps({k: v for k, v in summary.items() if k != "per_year"}, indent=2))


if __name__ == "__main__":
    main()
