#!/usr/bin/env bash
# Probe for #8 — how much more a reviewer reads when it is given the post-state
# of the touched files instead of the diff.
#
# This measures the reviewer's INPUT, not its recall. v1's finding was that the
# gate let 3 of 3 planted defects through in pre-existing code because it ran
# against the post-state and the reviewer had to guess which lines were new.
# Ruling 51 makes `git diff <base>..work` exact and free, and the natural claim
# is "that fixes recall".
#
# It is not this probe's claim and it is not measured here. Recall is an
# outcome, needs live agents and planted defects, and belongs to BAR item 5. All
# this establishes is the size of the haystack the two framings hand over.
#
# Usage: gate-signal.sh [repo] [commit-count]

set -uo pipefail

REPO="${1:-$PWD}"
COUNT="${2:-120}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cd "$REPO" || exit 1
echo "=== $REPO — git $(git --version | awk '{print $3}') on $(uname -s) ==="
echo "tracked files: $(git ls-files | wc -l | tr -d ' ')"

n=0
for sha in $(git rev-list --no-merges -n "$COUNT" HEAD); do
  files="$(git diff-tree --no-commit-id --name-only -r "$sha" | head -40)"
  [ -z "$files" ] && continue
  diffb="$(git diff "$sha^" "$sha" 2>/dev/null | wc -c | tr -d ' ')"
  [ "$diffb" = "0" ] && continue
  postb=0
  while IFS= read -r f; do
    sz="$(git cat-file -s "$sha:$f" 2>/dev/null || echo 0)"
    postb=$((postb + sz))
  done <<< "$files"
  [ "$postb" -eq 0 ] && continue
  printf '%s %s\n' "$diffb" "$postb" >> "$TMP"
  n=$((n+1))
done

echo "commits sampled: $n"
awk '{d+=$1; p+=$2; r=$2/$1; if(r>mx)mx=r; if(mn==0||r<mn)mn=r; a[NR]=r} END{
  if (NR==0) { print "no data"; exit }
  for(i=1;i<=NR;i++) for(j=i+1;j<=NR;j++) if(a[j]<a[i]){t=a[i];a[i]=a[j];a[j]=t}
  printf "diff bytes total:        %d\n", d;
  printf "post-state bytes total:  %d\n", p;
  printf "aggregate post/diff:     %.1fx\n", p/d;
  printf "median per-commit:       %.1fx\n", (NR%2? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2);
  printf "min / max per-commit:    %.1fx / %.1fx\n", mn, mx;
}' "$TMP"
