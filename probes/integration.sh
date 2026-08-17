#!/usr/bin/env bash
# Probe for #9 — getting work out of a clone and into the operator's repository
# without ever touching their working tree.
#
# Four claims that would otherwise be assumed:
#   1. a worker CAN push into the operator's repository through the clone's own
#      `origin`, and removing the remote takes that path away;
#   2. the parent can fetch FROM a clone by filesystem path with no remote
#      configured on either side;
#   3. `git merge-tree --write-tree` performs a real merge with NO working tree,
#      and reports conflicts rather than inventing a resolution;
#   4. `git update-ref --stdin` is genuinely atomic across a batch.
#
# Each with a negative control.

set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PARENT="$WORK/parent"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1));
  else echo "FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); fi
}

echo "=== git $(git --version | awk '{print $3}') on $(uname -s) ==="
echo

git init -q -b main "$PARENT"
cd "$PARENT" || exit 1
git config user.email probe@example.com; git config user.name Probe
printf 'a\n' > a.txt; printf 'b\n' > b.txt; printf 'shared\n' > shared.txt
git add -A && git commit -q -m base
BASE="$(git rev-parse HEAD)"
REFS_BEFORE="$(git for-each-ref --format='%(refname)' | sort)"
STATUS_BEFORE="$(git status --porcelain -uall | sort)"
INDEX_BEFORE="$(git hash-object .git/index)"
HEAD_BEFORE="$(git rev-parse HEAD)"

# ------------------------------------------------- 1. can a worker push back?
CLONE_X="$WORK/clone-x"
git clone -q --local "$PARENT" "$CLONE_X"
git -C "$CLONE_X" config user.email w@example.com; git -C "$CLONE_X" config user.name W
git -C "$CLONE_X" checkout -q -b work
printf 'agent was here\n' > "$CLONE_X/a.txt"
git -C "$CLONE_X" commit -q -am "agent commit"

echo "--- 1. the clone's own origin points at the operator's repository ---"
check "origin is the operator's repo" "$PARENT" "$(git -C "$CLONE_X" remote get-url origin)"
git -C "$CLONE_X" push -q origin work:refs/heads/pushed-by-agent 2>/dev/null
check "HAZARD CONFIRMED: an agent can push a branch into the operator's repo" "present" \
  "$(git rev-parse --verify -q refs/heads/pushed-by-agent >/dev/null 2>&1 && echo present || echo absent)"
git update-ref -d refs/heads/pushed-by-agent

git -C "$CLONE_X" remote remove origin
git -C "$CLONE_X" push -q origin work:refs/heads/pushed-again 2>/dev/null
check "with origin removed, the same push fails" "absent" \
  "$(git rev-parse --verify -q refs/heads/pushed-again >/dev/null 2>&1 && echo present || echo absent)"
# Honest limit: removing the remote removes the convenience, not the possibility.
git -C "$CLONE_X" push -q "$PARENT" work:refs/heads/pushed-by-path 2>/dev/null
check "LIMIT: an explicit path still works — this is a speed bump, not a boundary" "present" \
  "$(git rev-parse --verify -q refs/heads/pushed-by-path >/dev/null 2>&1 && echo present || echo absent)"
git update-ref -d refs/heads/pushed-by-path

echo
echo "--- 2. the parent fetches FROM the clone, by path, with no remote ---"
check "clone has no remotes at all" "" "$(git -C "$CLONE_X" remote)"
git fetch -q "$CLONE_X" work:refs/brigadier/run1/item/1
check "the item's work landed in the parent" "agent was here" \
  "$(git show refs/brigadier/run1/item/1:a.txt)"
check "objects still hardlinked after the fetch (nothing copied)" "yes" \
  "$( [ "$(find "$CLONE_X/.git/objects" -type f -links +1 | wc -l | tr -d ' ')" -gt 0 ] && echo yes || echo no )"

echo
echo "--- 3. merge-tree: a real merge with no working tree ---"
# Two items, disjoint paths, as ruling 14's legality filter intends.
CLONE_Y="$WORK/clone-y"
git clone -q --local "$PARENT" "$CLONE_Y"
git -C "$CLONE_Y" config user.email w@example.com; git -C "$CLONE_Y" config user.name W
git -C "$CLONE_Y" checkout -q -b work
printf 'item two touched b\n' > "$CLONE_Y/b.txt"
git -C "$CLONE_Y" commit -q -am "item two"
git -C "$CLONE_Y" remote remove origin
git fetch -q "$CLONE_Y" work:refs/brigadier/run1/item/2

CLEAN_TREE="$(git merge-tree --write-tree refs/brigadier/run1/item/1 refs/brigadier/run1/item/2 2>&1)"
clean_rc=$?
check "disjoint slices merge cleanly, rc=0" "0" "$clean_rc"
check "the merged tree carries item 1's change" "agent was here" \
  "$(git show "${CLEAN_TREE%%$'\n'*}:a.txt")"
check "the merged tree carries item 2's change" "item two touched b" \
  "$(git show "${CLEAN_TREE%%$'\n'*}:b.txt")"

# Now the conflict: two items that both touched shared.txt.
CLONE_Z="$WORK/clone-z"
git clone -q --local "$PARENT" "$CLONE_Z"
git -C "$CLONE_Z" config user.email w@example.com; git -C "$CLONE_Z" config user.name W
git -C "$CLONE_Z" checkout -q -b work
printf 'version from item three\n' > "$CLONE_Z/shared.txt"
git -C "$CLONE_Z" commit -q -am "item three"
git -C "$CLONE_Z" remote remove origin
git fetch -q "$CLONE_Z" work:refs/brigadier/run1/item/3

CLONE_W="$WORK/clone-w"
git clone -q --local "$PARENT" "$CLONE_W"
git -C "$CLONE_W" config user.email w@example.com; git -C "$CLONE_W" config user.name W
git -C "$CLONE_W" checkout -q -b work
printf 'version from item four\n' > "$CLONE_W/shared.txt"
git -C "$CLONE_W" commit -q -am "item four"
git -C "$CLONE_W" remote remove origin
git fetch -q "$CLONE_W" work:refs/brigadier/run1/item/4

CONFLICT_OUT="$(git merge-tree --write-tree --name-only refs/brigadier/run1/item/3 refs/brigadier/run1/item/4 2>&1)"
conflict_rc=$?
check "NEGATIVE CONTROL: a real conflict returns non-zero" "nonzero" \
  "$( [ $conflict_rc -ne 0 ] && echo nonzero || echo zero )"
check "and names the conflicting path" "yes" \
  "$(printf '%s' "$CONFLICT_OUT" | grep -q 'shared.txt' && echo yes || echo no)"
echo "        merge-tree conflict report:"
printf '%s\n' "$CONFLICT_OUT" | sed 's/^/          /'

echo
echo "--- 4. is update-ref --stdin atomic across a batch? ---"
printf 'create refs/brigadier/run1/ok %s\ncreate refs/brigadier/run1/also-ok %s\n' "$BASE" "$BASE" \
  | git update-ref --stdin
check "a good batch applies" "present" \
  "$(git rev-parse --verify -q refs/brigadier/run1/ok >/dev/null 2>&1 && echo present || echo absent)"
git update-ref -d refs/brigadier/run1/ok; git update-ref -d refs/brigadier/run1/also-ok

# One good ref and one that cannot be created (wrong old-value). All or nothing.
printf 'create refs/brigadier/run1/first %s\nupdate refs/brigadier/run1/second %s %s\n' \
  "$BASE" "$BASE" "0000000000000000000000000000000000000001" \
  | git update-ref --stdin 2>/dev/null
check "NEGATIVE CONTROL: one bad entry leaves the GOOD one unapplied too" "absent" \
  "$(git rev-parse --verify -q refs/brigadier/run1/first >/dev/null 2>&1 && echo present || echo absent)"

echo
echo "--- 5. does the diff catch a write outside the item's declared ownership? ---"
# Item 1 declared only a.txt but its clone could have touched anything.
CLONE_V="$WORK/clone-v"
git clone -q --local "$PARENT" "$CLONE_V"
git -C "$CLONE_V" config user.email w@example.com; git -C "$CLONE_V" config user.name W
git -C "$CLONE_V" checkout -q -b work
printf 'declared\n' > "$CLONE_V/a.txt"
printf 'NOT declared\n' > "$CLONE_V/b.txt"
git -C "$CLONE_V" commit -q -am "strayed"
TOUCHED="$(git -C "$CLONE_V" diff --name-only "$BASE"..work | sort | tr '\n' ' ')"
check "the diff names every path the item actually touched" "a.txt b.txt " "$TOUCHED"

echo
echo "--- the operator's repository, through all of the above ---"
check "working tree unchanged" "$STATUS_BEFORE" "$(git status --porcelain -uall | sort)"
check ".git/index unchanged"   "$INDEX_BEFORE"  "$(git hash-object .git/index)"
check "HEAD unmoved"           "$HEAD_BEFORE"   "$(git rev-parse HEAD)"
comm -13 <(printf '%s\n' "$REFS_BEFORE") <(git for-each-ref --format='%(refname)' | sort) > "$WORK/newrefs"
echo "        refs brigadier added: $(tr '\n' ' ' < "$WORK/newrefs")"
# AGENTS.md: never read an exit code through a pipe. Count into a file, read the file.
grep -cv '^refs/brigadier/' "$WORK/newrefs" > "$WORK/stray" 2>/dev/null
check "every new ref is under refs/brigadier/" "0" "$(cat "$WORK/stray")"
# Negative control: the count can be non-zero.
printf 'refs/heads/stray\n' >> "$WORK/newrefs"
grep -cv '^refs/brigadier/' "$WORK/newrefs" > "$WORK/stray2" 2>/dev/null
check "NEGATIVE CONTROL: a stray ref is counted" "1" "$(cat "$WORK/stray2")"

echo
echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
