#!/usr/bin/env python3
"""Verify an HF push by listing the repo back and comparing to what was SENT.

  python3 scripts/publish-nsr/verify-push.py <repo> <model|dataset> <s3://...prefix/>

e.g.
  python3 scripts/publish-nsr/verify-push.py NYSgpt/cshl-encoder-bge-m3-qpairs model \
    s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-192100-train/serve/

Exit 0 = every sent object is on the Hub at the sent byte size, the card is there, and the
repo is private. Exit 1 = a real discrepancy. Exit 2 = the prefix was empty, so there was
nothing to compare and the check would have passed vacuously.


An upload that dies at 96% looks complete from the process side: the box prints its
success line, terminates, and the repo is missing a file nobody enumerated. So the
check is not "did the log say done" — it is "does every object we handed the box exist
on the Hub, at the byte size we handed it".
"""
import json, subprocess, sys, urllib.request

REGION = "us-east-1"


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout.strip()


def s3_manifest(prefix):
    """{relative path: size} for everything under an s3:// prefix."""
    out = sh("aws", "s3", "ls", prefix, "--recursive", "--region", REGION)
    base = prefix.split("cshl-embed-rxiv/", 1)[1]
    m = {}
    for line in out.splitlines():
        p = line.split(maxsplit=3)
        if len(p) < 4:
            continue
        key, size = p[3], int(p[2])
        if key.startswith(base):
            m[key[len(base):]] = size
    return m


def hf(repo, kind, token):
    path = "models" if kind == "model" else "datasets"
    req = urllib.request.Request(
        f"https://huggingface.co/api/{path}/{repo}?blobs=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    return json.load(urllib.request.urlopen(req))


def main():
    repo, kind, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    token = sh("aws", "ssm", "get-parameter", "--region", REGION, "--name", "/nsr/hf/token",
               "--with-decryption", "--query", "Parameter.Value", "--output", "text")
    d = hf(repo, kind, token)
    remote = {s["rfilename"]: s.get("size") for s in d.get("siblings", [])}
    sent = s3_manifest(prefix)

    print(f"repo    : {repo}  ({kind})")
    print(f"private : {d.get('private')}   <- must be True")
    print(f"modified: {d.get('lastModified')}")
    print(f"remote  : {len(remote)} files")
    print(f"sent    : {len(sent)} objects under {prefix}\n")

    # A comparison over an empty "sent" set passes trivially, which is the same
    # nothing-happened-successfully bug this script exists to catch. Refuse it.
    if not sent:
        print(f"FAIL: nothing found under {prefix} — there is nothing to verify against, "
              f"so this check would pass vacuously.")
        sys.exit(2)

    missing, mismatched = [], []
    for rel, size in sorted(sent.items()):
        if rel not in remote:
            missing.append(rel)
        elif remote[rel] is not None and remote[rel] != size:
            mismatched.append((rel, size, remote[rel]))
    for rel, size in sorted(sent.items()):
        mark = "MISSING" if rel in missing else "ok"
        print(f"  {mark:8} {size:>12,}  {rel}")
    extra = sorted(set(remote) - set(sent) - {".gitattributes", "README.md"})
    if extra:
        print(f"\n  {len(extra)} file(s) already in the repo and not part of this push (kept):")
        for e in extra:
            print(f"    - {e}")
    if "README.md" not in remote:
        missing.append("README.md (the card)")

    print()
    if missing or mismatched or d.get("private") is not True:
        if d.get("private") is not True:
            print("FAIL: repo is not private")
        for m in missing:
            print(f"FAIL: missing on the Hub: {m}")
        for rel, a, b in mismatched:
            print(f"FAIL: size mismatch {rel}: sent {a}, hub {b}")
        sys.exit(1)
    print(f"VERIFIED: all {len(sent)} sent objects present at the sent byte size, card present, repo private.")


main()
