#!/usr/bin/env bash
# Probe for #29 — capturing HEAD plus uncommitted tracked AND untracked work as
# a commit, without touching the operator's index or working tree, and getting
# it into a `git clone --local`.
#
# The load-bearing claim this exists to test is "provably cannot disturb the
# operator's uncommitted work". That is not a claim to assert.
#
# Every check has a negative control beside it.

set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PARENT="$WORK/parent"
OUT="$WORK/out"
mkdir -p "$OUT"

pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1));
  else echo "FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); fi
}

echo "=== git $(git --version | awk '{print $3}') on $(uname -s) ==="
echo

# ---------------------------------------------------------------- the parent
git init -q "$PARENT"
cd "$PARENT" || exit 1
git config user.email probe@example.com
git config user.name Probe
printf 'committed\n'      > committed.txt
printf 'original\n'       > modified.txt
printf 'doomed\n'         > deleted.txt
printf 'ignored/\n*.log\n' > .gitignore
mkdir -p ignored && printf 'dep\n' > ignored/dep.txt
printf 'noise\n' > noise.log
git add -A && git commit -q -m "base commit"

# A tracked file that ALSO matches .gitignore. This is the case that separates
# the two ways of building the temporary index.
printf 'tracked-and-ignored\n' > tracked.log
git add -f tracked.log && git commit -q -m "tracked file matching .gitignore"

HEAD_SHA="$(git rev-parse HEAD)"

# The operator's dirty state: one modification, one deletion, one untracked file.
printf 'edited by the operator\n' > modified.txt
rm deleted.txt
printf 'brand new, never added\n' > untracked.txt

STATUS_BEFORE="$(git status --porcelain=v1 -uall | sort)"
INDEX_BEFORE="$(git hash-object .git/index)"
TREE_BEFORE="$(find . -path ./.git -prune -o -type f -print | sort | xargs shasum | shasum | awk '{print $1}')"

# --------------------------------------------- 1. temp index, seeded from HEAD
SCRATCH_INDEX="$WORK/index.seeded"
GIT_INDEX_FILE="$SCRATCH_INDEX" git read-tree HEAD
GIT_INDEX_FILE="$SCRATCH_INDEX" git add -A
TREE_SEEDED="$(GIT_INDEX_FILE="$SCRATCH_INDEX" git write-tree)"
BASE_SHA="$(git commit-tree "$TREE_SEEDED" -p "$HEAD_SHA" -m "brigadier base state")"

# ------------------------------------ 2. temp index, NOT seeded (the wrong way)
SCRATCH_EMPTY="$WORK/index.empty"
GIT_INDEX_FILE="$SCRATCH_EMPTY" git add -A
TREE_EMPTY="$(GIT_INDEX_FILE="$SCRATCH_EMPTY" git write-tree)"

echo "--- does building the base state touch the operator's repository? ---"
check "operator's git status unchanged"  "$STATUS_BEFORE" "$(git status --porcelain=v1 -uall | sort)"
check "operator's .git/index unchanged"  "$INDEX_BEFORE"  "$(git hash-object .git/index)"
check "operator's working tree unchanged" "$TREE_BEFORE" \
  "$(find . -path ./.git -prune -o -type f -print | sort | xargs shasum | shasum | awk '{print $1}')"
check "operator's HEAD unmoved"          "$HEAD_SHA"     "$(git rev-parse HEAD)"

# Negative control: the checks above can fail. Do the naive thing on purpose.
git add modified.txt
check "NEGATIVE CONTROL: touching the real index IS detected" "changed" \
  "$( [ "$INDEX_BEFORE" != "$(git hash-object .git/index)" ] && echo changed || echo unchanged )"
git reset -q
INDEX_BEFORE="$(git hash-object .git/index)"

echo
echo "--- what the base commit contains ---"
seeded_ls="$(git ls-tree -r --name-only "$TREE_SEEDED" | sort | tr '\n' ' ')"
empty_ls="$(git ls-tree -r --name-only "$TREE_EMPTY" | sort | tr '\n' ' ')"
echo "  seeded from HEAD : $seeded_ls"
echo "  empty index      : $empty_ls"
check "modification captured" "edited by the operator" \
  "$(git show "$TREE_SEEDED:modified.txt")"
check "untracked file captured" "brand new, never added" \
  "$(git show "$TREE_SEEDED:untracked.txt")"
check "deletion captured" "absent" \
  "$(git cat-file -e "$TREE_SEEDED:deleted.txt" 2>/dev/null && echo present || echo absent)"
check "gitignored dependency NOT captured" "absent" \
  "$(git cat-file -e "$TREE_SEEDED:ignored/dep.txt" 2>/dev/null && echo present || echo absent)"
check "gitignored log NOT captured" "absent" \
  "$(git cat-file -e "$TREE_SEEDED:noise.log" 2>/dev/null && echo present || echo absent)"
check "SEEDED index keeps the tracked-but-ignored file" "present" \
  "$(git cat-file -e "$TREE_SEEDED:tracked.log" 2>/dev/null && echo present || echo absent)"
check "EMPTY index SILENTLY DROPS it (this is why the seed matters)" "absent" \
  "$(git cat-file -e "$TREE_EMPTY:tracked.log" 2>/dev/null && echo present || echo absent)"

echo
echo "--- does it compose with git clone --local? ---"
# The scratch ref lives outside refs/heads/ so it is invisible to the operator's
# `git branch` and to a default clone refspec.
SCRATCH_REF="refs/brigadier/probe-run/base"
git update-ref "$SCRATCH_REF" "$BASE_SHA"
check "scratch ref is invisible to git branch" "" "$(git branch --list --format='%(refname)' | grep brigadier || true)"

CLONE_A="$WORK/clone-default"
git clone -q --local "$PARENT" "$CLONE_A"
check "NEGATIVE CONTROL: a default clone does NOT carry the scratch ref" "absent" \
  "$(git -C "$CLONE_A" rev-parse --verify -q "$SCRATCH_REF" >/dev/null 2>&1 && echo present || echo absent)"
check "NEGATIVE CONTROL: a default clone sees HEAD's content only" "original" \
  "$(cat "$CLONE_A/modified.txt")"
check "NEGATIVE CONTROL: a default clone has no untracked work" "absent" \
  "$( [ -f "$CLONE_A/untracked.txt" ] && echo present || echo absent )"

CLONE_B="$WORK/clone-base"
t0=$(date +%s%N)
git clone -q --local --no-checkout "$PARENT" "$CLONE_B"
git -C "$CLONE_B" fetch -q origin "$SCRATCH_REF:refs/heads/brigadier-base"
git -C "$CLONE_B" checkout -q brigadier-base
t1=$(date +%s%N)
check "worker sees the operator's MODIFICATION" "edited by the operator" "$(cat "$CLONE_B/modified.txt")"
check "worker sees the operator's UNTRACKED file" "brand new, never added" "$(cat "$CLONE_B/untracked.txt")"
check "worker sees the deletion" "absent" \
  "$( [ -f "$CLONE_B/deleted.txt" ] && echo present || echo absent )"
check "worker does NOT get the gitignored dependency" "absent" \
  "$( [ -f "$CLONE_B/ignored/dep.txt" ] && echo present || echo absent )"
check "diff base..head is available and empty at the start" "" \
  "$(git -C "$CLONE_B" diff --name-only brigadier-base..HEAD)"
echo "  clone+fetch+checkout: $(( (t1 - t0) / 1000000 )) ms"

# Is the objects hardlink still in force after the fetch? (#19's cost model.)
check "objects are hardlinked, so the fetch transferred nothing new" "yes" \
  "$( [ "$(find "$CLONE_B/.git/objects" -type f -links +1 | wc -l | tr -d ' ')" -gt 0 ] && echo yes || echo no )"

echo
echo "--- cleanup, and the operator's tree afterwards ---"
git update-ref -d "$SCRATCH_REF"
check "scratch ref deleted" "absent" \
  "$(git rev-parse --verify -q "$SCRATCH_REF" >/dev/null 2>&1 && echo present || echo absent)"
check "operator's git status STILL unchanged" "$STATUS_BEFORE" "$(git status --porcelain=v1 -uall | sort)"
check "operator's .git/index STILL unchanged" "$INDEX_BEFORE" "$(git hash-object .git/index)"
check "operator's working tree STILL unchanged" "$TREE_BEFORE" \
  "$(find . -path ./.git -prune -o -type f -print | sort | xargs shasum | shasum | awk '{print $1}')"

echo
echo "--- an unborn HEAD (a repo with no commits) ---"
EMPTY_REPO="$WORK/empty"
git init -q "$EMPTY_REPO"
cd "$EMPTY_REPO" || exit 1
git config user.email probe@example.com; git config user.name Probe
printf 'only file\n' > only.txt
GIT_INDEX_FILE="$WORK/index.unborn" git read-tree HEAD 2>/dev/null
rt=$?
GIT_INDEX_FILE="$WORK/index.unborn" git add -A
UNBORN_TREE="$(GIT_INDEX_FILE="$WORK/index.unborn" git write-tree)"
check "read-tree HEAD fails on an unborn HEAD (must be handled, not assumed)" "nonzero" \
  "$( [ $rt -ne 0 ] && echo nonzero || echo zero )"
check "a parentless base commit is still constructible" "ok" \
  "$(git commit-tree "$UNBORN_TREE" -m base >/dev/null 2>&1 && echo ok || echo failed)"

echo
echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
