#!/usr/bin/env bash
# Probe for #30 — every way a clone can make brigadier's own git commands
# execute code, and what actually closes each.
#
# The ticket's rule: assert on the EFFECT — a file written outside the clone —
# never on the presence of a flag. v1's finding 41 is that a flag assertion
# survives a refactor that removes the property.
#
# So every check below plants a payload that writes a canary OUTSIDE the clone,
# runs an ordinary brigadier git command, and asks whether the canary exists.

set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PARENT="$WORK/parent"
CANARY_DIR="$WORK/escaped"
mkdir -p "$CANARY_DIR"
EMPTY_HOOKS="$WORK/no-hooks"
mkdir -p "$EMPTY_HOOKS"

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1));
  else echo "FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); fi
}
canary() { # canary <name> -> "escaped" | "contained"
  [ -f "$CANARY_DIR/$1" ] && echo escaped || echo contained
}
reset_canaries() { rm -f "$CANARY_DIR"/*; }

payload() { # payload <canary-name>  — a script body that writes outside the clone
  printf '#!/bin/sh\ntouch "%s/%s"\nexit 0\n' "$CANARY_DIR" "$1"
}

echo "=== git $(git --version | awk '{print $3}') on $(uname -s) ==="
echo

git init -q -b main "$PARENT"
cd "$PARENT" || exit 1
git config user.email probe@example.com; git config user.name Probe
printf 'hello\n' > a.txt
git add -A && git commit -q -m base

fresh_clone() { # fresh_clone <dir>
  rm -rf "$1"
  git clone -q --local "$PARENT" "$1"
  git -C "$1" config user.email w@example.com
  git -C "$1" config user.name W
}

plant_hook() { # plant_hook <clone> <hook-name> <canary>
  payload "$3" > "$1/.git/hooks/$2"
  chmod +x "$1/.git/hooks/$2"
}

C="$WORK/clone"

# ============================================================ family 1: hooks
echo "--- family 1: .git/hooks ---"

fresh_clone "$C"; reset_canaries
plant_hook "$C" pre-commit h1
printf 'agent edit\n' > "$C/a.txt"
git -C "$C" commit -q -am "worker commit" 2>/dev/null
check "HAZARD CONFIRMED: a planted pre-commit runs on an ordinary git commit" "escaped" "$(canary h1)"

fresh_clone "$C"; reset_canaries
plant_hook "$C" pre-commit h2
printf 'agent edit\n' > "$C/a.txt"
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" commit -q -am "worker commit" 2>/dev/null
check "core.hooksPath=<empty> closes it" "contained" "$(canary h2)"

# post-checkout is NOT covered by --no-verify. This is the ticket's claim.
fresh_clone "$C"; reset_canaries
plant_hook "$C" post-checkout h3
git -C "$C" checkout -q -b other 2>/dev/null
check "HAZARD: post-checkout runs on git checkout" "escaped" "$(canary h3)"

fresh_clone "$C"; reset_canaries
plant_hook "$C" post-checkout h4
git -C "$C" checkout -q --no-verify -b other 2>/dev/null || git -C "$C" checkout -q -b other 2>/dev/null
check "NEGATIVE CONTROL: --no-verify does NOT cover post-checkout" "escaped" "$(canary h4)"

fresh_clone "$C"; reset_canaries
plant_hook "$C" post-checkout h5
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" checkout -q -b other 2>/dev/null
check "core.hooksPath DOES cover post-checkout" "contained" "$(canary h5)"

# reference-transaction fires on update-ref — the exact command ruling 51 uses.
fresh_clone "$C"; reset_canaries
plant_hook "$C" reference-transaction h6
git -C "$C" update-ref refs/brigadier/probe/x HEAD 2>/dev/null
check "HAZARD: reference-transaction runs on git update-ref (ruling 51's command)" "escaped" "$(canary h6)"

fresh_clone "$C"; reset_canaries
plant_hook "$C" reference-transaction h7
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" update-ref refs/brigadier/probe/x HEAD 2>/dev/null
check "core.hooksPath covers reference-transaction too" "contained" "$(canary h7)"

# Does the PARENT's own update-ref run the parent's hooks? (It should - but the
# parent is the operator's repo and its hooks are the operator's business.)
fresh_clone "$C"; reset_canaries
plant_hook "$C" post-merge h8
git -C "$C" merge -q --allow-unrelated-histories HEAD 2>/dev/null
check "post-merge on a no-op merge does not fire (informational)" "contained" "$(canary h8)"

echo
echo "--- can the hooks directory simply be made unusable at creation? ---"
fresh_clone "$C"; reset_canaries
rm -rf "$C/.git/hooks"
printf 'not a directory\n' > "$C/.git/hooks"
printf 'agent edit\n' > "$C/a.txt"
git -C "$C" commit -q -am "worker commit" 2>/dev/null
rc=$?
check "replacing .git/hooks with a FILE still lets the commit succeed" "0" "$rc"
# ...and the agent can just delete it and put a directory back.
rm -f "$C/.git/hooks"; mkdir -p "$C/.git/hooks"
plant_hook "$C" pre-commit h9
printf 'agent edit 2\n' > "$C/a.txt"
git -C "$C" commit -q -am "worker commit 2" 2>/dev/null
check "NEGATIVE: an agent restores the directory and the hook fires again" "escaped" "$(canary h9)"

# =========================================================== family 2: config
echo
echo "--- family 2: .git/config, which core.hooksPath does NOT cover ---"

fresh_clone "$C"; reset_canaries
payload c1 > "$WORK/fsmonitor.sh"; chmod +x "$WORK/fsmonitor.sh"
git -C "$C" config core.fsmonitor "$WORK/fsmonitor.sh"
git -C "$C" status --porcelain > /dev/null 2>&1
check "HAZARD: core.fsmonitor executes on git status" "escaped" "$(canary c1)"

fresh_clone "$C"; reset_canaries
payload c2 > "$WORK/fsmonitor2.sh"; chmod +x "$WORK/fsmonitor2.sh"
git -C "$C" config core.fsmonitor "$WORK/fsmonitor2.sh"
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" status --porcelain > /dev/null 2>&1
check "NEGATIVE CONTROL: core.hooksPath does NOT close core.fsmonitor" "escaped" "$(canary c2)"

fresh_clone "$C"; reset_canaries
payload c3 > "$WORK/fsmonitor3.sh"; chmod +x "$WORK/fsmonitor3.sh"
git -C "$C" config core.fsmonitor "$WORK/fsmonitor3.sh"
git -C "$C" -c core.fsmonitor= status --porcelain > /dev/null 2>&1
check "an explicit -c core.fsmonitor= DOES close it" "contained" "$(canary c3)"

# The serving side: does the PARENT fetching FROM the clone run the clone's
# uploadpack hook? This is ruling 51's exact integration command.
fresh_clone "$C"; reset_canaries
git -C "$C" checkout -q -b work
printf 'work\n' > "$C/a.txt"; git -C "$C" commit -q -am work
payload c4 > "$WORK/packhook.sh"; chmod +x "$WORK/packhook.sh"
git -C "$C" config uploadpack.packObjectsHook "$WORK/packhook.sh"
git -C "$PARENT" fetch -q "$C" work:refs/brigadier/probe/w 2>/dev/null
check "uploadpack.packObjectsHook on a local fetch from the clone" "contained" "$(canary c4)"

# And a clone-side alias / pager, in case brigadier ever shells a porcelain cmd.
fresh_clone "$C"; reset_canaries
payload c5 > "$WORK/pager.sh"; chmod +x "$WORK/pager.sh"
git -C "$C" config core.pager "$WORK/pager.sh"
git -C "$C" -c color.ui=always log --oneline 2>/dev/null | cat > /dev/null
check "core.pager is not reached when stdout is not a tty (informational)" "contained" "$(canary c5)"

# ======================================================= family 3: attributes
echo
echo "--- family 3: .gitattributes filters ---"
fresh_clone "$C"; reset_canaries
payload f1 > "$WORK/smudge.sh"; chmod +x "$WORK/smudge.sh"
printf 'a.txt filter=evil\n' > "$C/.gitattributes"
git -C "$C" add .gitattributes && git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" commit -q -m attrs
# The attribute alone is inert: the DRIVER must exist in config.
rm -f "$C/a.txt"
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" checkout -q -- a.txt 2>/dev/null
check "a .gitattributes filter with NO driver defined is inert" "contained" "$(canary f1)"

reset_canaries
git -C "$C" config filter.evil.smudge "$WORK/smudge.sh"
rm -f "$C/a.txt"
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" checkout -q -- a.txt 2>/dev/null
check "HAZARD: with the driver in .git/config the smudge filter executes" "escaped" "$(canary f1)"
echo "        => family 3 collapses into family 2: an attribute is inert without a config driver."

# ============================================ the mechanism: don't be in there
echo
echo "--- the fix: after the agent runs, do brigadier's git work in the PARENT ---"
fresh_clone "$C"; reset_canaries
git -C "$C" checkout -q -b work
printf 'strayed\n' > "$C/b.txt"; printf 'owned\n' > "$C/a.txt"
git -C "$C" add -A
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" commit -q -m work
BASE_SHA="$(git -C "$PARENT" rev-parse HEAD)"
# The agent has planted both families. brigadier touches none of it.
payload m1 > "$WORK/fsm.sh"; chmod +x "$WORK/fsm.sh"
git -C "$C" config core.fsmonitor "$WORK/fsm.sh"
plant_hook "$C" reference-transaction m2

git -C "$PARENT" fetch -q "$C" work:refs/brigadier/probe/m 2>/dev/null
IN_CLONE="$(git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" -c core.fsmonitor= diff --name-only "$BASE_SHA"..work | sort | tr '\n' ' ')"
IN_PARENT="$(git -C "$PARENT" diff --name-only "$BASE_SHA"..refs/brigadier/probe/m | sort | tr '\n' ' ')"
check "the ownership diff computes identically in the PARENT" "$IN_CLONE" "$IN_PARENT"
check "and it is the right answer" "a.txt b.txt " "$IN_PARENT"
check "neither planted payload fired" "contained" "$(canary m1)"
check "reference-transaction did not fire either" "contained" "$(canary m2)"

echo
echo "--- for a POOLED directory, which brigadier must re-enter: restore then run ---"
# Ruling 49 recycles a read-only directory with fetch/checkout/clean, inside a
# directory a previous agent could write. Restoring config and hooks from
# brigadier's own copy is a plain filesystem operation, before git is invoked.
fresh_clone "$C"; reset_canaries
cp "$C/.git/config" "$WORK/known-good-config"
payload p1 > "$WORK/fsm2.sh"; chmod +x "$WORK/fsm2.sh"
git -C "$C" config core.fsmonitor "$WORK/fsm2.sh"
plant_hook "$C" post-checkout p2
git -C "$C" checkout -q -b other 2>/dev/null
check "NEGATIVE CONTROL: without the restore, recycling a pooled dir executes both" "escaped" "$(canary p2)"
git -C "$C" status --porcelain >/dev/null 2>&1
check "NEGATIVE CONTROL: and the config family too" "escaped" "$(canary p1)"

reset_canaries
rm -rf "$C/.git/hooks"; mkdir -p "$C/.git/hooks"
cp "$WORK/known-good-config" "$C/.git/config"
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" checkout -q -b other2 2>/dev/null
git -C "$C" -c core.hooksPath="$EMPTY_HOOKS" status --porcelain >/dev/null 2>&1
check "restoring .git/config and .git/hooks first closes both families" "contained" "$(canary p2)"
check "including the config one" "contained" "$(canary p1)"

echo
echo "--- does a clone inherit the parent's hooks? ---"
reset_canaries
plant_hook "$PARENT" pre-commit q1
fresh_clone "$WORK/clone-q"
check "git clone --local does NOT copy the source repo's hooks" "absent" \
  "$( [ -f "$WORK/clone-q/.git/hooks/pre-commit" ] && echo present || echo absent )"
rm -f "$PARENT/.git/hooks/pre-commit"

echo
echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
