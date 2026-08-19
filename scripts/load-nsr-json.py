"""
Load NSR JSON entries (2000-2026) into Supabase nsr table.
Reads individual .json files from extracted archive, flattens to table schema,
and batch upserts via REST API.
"""

import json
import os
import sys
import time
import urllib.request

SUPABASE_URL = "https://stsumwwmyijxutabzice.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0c3Vtd3dteWlqeHV0YWJ6aWNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MjM0NzksImV4cCI6MjA4NzE5OTQ3OX0.jTRjEfHDp5JaQUf14FWegYeDVIaYmswSV2eY4eRXfEA"

ENTRIES_DIR = "/tmp/nsr-full/nsr/entries"
MIN_YEAR = 2000
BATCH_SIZE = 200


def flatten_record(r):
    """Flatten a single NSR JSON record to match nsr table columns."""
    # Authors: "I.Last; I.Last; ..."
    authors = "; ".join(
        ".".join(a.get("initials", [])) + "." + a["lastName"]
        for a in r.get("authors", [])
    ) or None

    # Keywords: full sentence text from sentenceGroups
    kw_parts = []
    for sg in r.get("sentenceGroups", []):
        for sent in sg.get("sentences", []):
            for phrase in sent.get("phrases", []):
                if phrase.get("text"):
                    kw_parts.append(phrase["text"])
    keywords = "; ".join(kw_parts) if kw_parts else None

    # EXFOR keys
    exfor = "; ".join(r.get("exforKeys", [])) or None

    title = r.get("title")
    if not title:
        return None  # skip records with no title

    return {
        "key_number": r["keyNumber"],
        "pub_year": r["publicationYear"],
        "reference": r.get("referenceText"),
        "authors": authors,
        "title": title,
        "doi": r.get("doi"),
        "keywords": keywords,
        "exfor_keys": exfor,
    }


def upsert_batch(rows):
    """Upsert a batch of rows via Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/nsr"
    body = json.dumps(rows).encode("utf-8")

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "resolution=merge-duplicates")  # upsert on key_number

    try:
        resp = urllib.request.urlopen(req)
        return resp.status
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"\n  ERROR {e.code}: {error_body[:200]}")
        return e.code


def main():
    print(f"Scanning {ENTRIES_DIR} for records {MIN_YEAR}-2026...")

    # Collect all filenames for year >= MIN_YEAR
    filenames = []
    for f in os.listdir(ENTRIES_DIR):
        if not f.endswith(".json"):
            continue
        try:
            year = int(f[:4])
            if year >= MIN_YEAR:
                filenames.append(f)
        except ValueError:
            continue

    filenames.sort()
    total = len(filenames)
    print(f"Found {total:,} records to load\n")

    # Process in batches
    loaded = 0
    errors = 0
    start = time.time()

    for i in range(0, total, BATCH_SIZE):
        batch_files = filenames[i : i + BATCH_SIZE]
        rows = []
        for f in batch_files:
            with open(os.path.join(ENTRIES_DIR, f)) as fh:
                r = json.load(fh)
            row = flatten_record(r)
            if row:
                rows.append(row)

        status = upsert_batch(rows)
        if status in (200, 201):
            loaded += len(rows)
        else:
            errors += len(rows)

        elapsed = time.time() - start
        rate = loaded / elapsed if elapsed > 0 else 0
        print(f"  {loaded:,}/{total:,} loaded ({rate:.0f}/s) | errors: {errors}", end="\r")

    elapsed = time.time() - start
    print(f"\n\nDone! {loaded:,} records loaded in {elapsed:.1f}s ({errors} errors)")


if __name__ == "__main__":
    main()
