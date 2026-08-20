#!/usr/bin/env bash
# rescue-qp3-commits.sh — move qp3's commits off lane/bedrock-kb and onto its own
# branch, WITHOUT touching the shared working tree.
#
# WHY THIS EXISTS. /Users/brendanstanton/Code/cshl is ONE worktree shared with the
# qp3 session. `git checkout -b lane/bedrock-kb` in it moved HEAD out from under
# that session, so its commits land on this lane's branch instead of its own. Two
# landed within an hour before anyone noticed. This sweep is idempotent and safe
# to re-run; run it until the shared tree's HEAD is put back on lane/rxiv-load,
# which is the actual fix and needs a checkout nobody wanted to do mid-run.
#
# It cherry-picks into a THROWAWAY worktree, so the shared tree's HEAD, index and
# files are never touched and no command the other session is mid-way through can
# be disturbed.
set -euo pipefail
SRC="${SRC:-lane/bedrock-kb}"; DST="${DST:-lane/rxiv-load}"; PAT="${PAT:-lane-qp3}"
FIX="$(mktemp -d)/rescue"
cleanup() { git worktree remove --force "$FIX" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# `git cherry` compares by PATCH-ID, not SHA. That distinction is the whole
# correctness of this script: a commit already rescued has a DIFFERENT sha on
# $DST, so a sha-based `log --not` lists it as still missing and the re-run
# conflicts trying to apply an already-applied patch. `+` means genuinely absent.
MISSING=$(git cherry "$DST" "$SRC" | awk '$1=="+"{print $2}' \
          | while read -r s; do git log --format='%h %s' -1 "$s"; done | grep -i "$PAT" || true)
[ -z "$MISSING" ] && { echo "nothing stranded on $SRC"; exit 0; }
echo "stranded on $SRC:"; echo "$MISSING" | sed 's/^/  /'
git worktree add "$FIX" "$DST" >/dev/null
while read -r sha _; do
  [ -z "$sha" ] && continue
  git -C "$FIX" -c user.name="Brendan Stanton" -c user.email="brendan@nysgpt.com" cherry-pick "$sha" >/dev/null
  new=$(git -C "$FIX" log --format=%h -1)
  if diff <(git show "$sha" --format="") <(git show "$new" --format="") >/dev/null; then
    echo "  $sha -> $new  identical diff"
  else
    echo "  $sha -> $new  DIFFERS — inspect before trusting"; fi
done <<< "$MISSING"
echo "$DST now at: $(git log --oneline -1 "$DST")"
