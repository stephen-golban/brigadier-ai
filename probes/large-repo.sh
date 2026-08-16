#!/bin/bash
# Probe — ticket #19. What the clone model costs on a genuinely large repository,
# and what the pool actually saves.
#
# Every clone target is fresh, so each timing is a first touch. Times use
# `/usr/bin/time -p` into a file rather than a shell variable, and exit codes are
# captured directly rather than through a pipe.
#
# Usage: large-repo.sh <source-repo> <scratch-dir>
set -u

SRC="$1"
OUT="$2"
rm -rf "$OUT"; mkdir -p "$OUT"

say() { printf 'MEASURED  %-34s %s\n' "$1" "$2"; }

# du -sm on the whole tree, and separately on .git, so checkout cost is visible.
sizes() {
  local d="$1"
  local total git
  total=$(du -sm "$d" 2>/dev/null | cut -f1)
  git=$(du -sm "$d/.git" 2>/dev/null | cut -f1)
  echo "${total}MB total / ${git}MB .git"
}

timed() { # timed <label> <target> -- <cmd...>
  local label="$1"; local target="$2"; shift 3
  local tf="$OUT/$label.time"
  /usr/bin/time -p "$@" > "$OUT/$label.out" 2> "$tf"
  local rc=$?
  local real
  real=$(grep '^real' "$tf" | awk '{print $2}')
  if [ "$rc" -ne 0 ]; then
    say "$label" "FAILED rc=$rc $(tail -2 "$tf" | tr '\n' ' ' | cut -c1-160)"
    return
  fi
  say "$label" "${real}s  $(sizes "$target")"
}

say "source" "$SRC  $(sizes "$SRC")"
say "tracked-files" "$(git -C "$SRC" ls-files | wc -l | tr -d ' ')"

# ---------------------------------------------------------------- baselines
timed clone-local-full        "$OUT/full"     -- git clone --local --quiet "$SRC" "$OUT/full"
timed clone-local-nocheckout  "$OUT/nocheck"  -- git clone --local --no-checkout --quiet "$SRC" "$OUT/nocheck"

# ------------------------------------------------------- partial / sparse
# --filter over a local path needs the file:// transport; a plain path bypasses
# the pack protocol entirely and the filter is silently ignored. Using file://
# also means this is NOT hardlinked, which is itself part of the cost.
timed clone-filter-blobnone   "$OUT/blobless" -- git clone --filter=blob:none --quiet "file://$SRC" "$OUT/blobless"
timed clone-sparse-nocheckout "$OUT/sparse"   -- git clone --filter=blob:none --no-checkout --quiet "file://$SRC" "$OUT/sparse"

if [ -d "$OUT/sparse/.git" ]; then
  ( cd "$OUT/sparse" && git sparse-checkout set --cone src 2>/dev/null && git checkout --quiet 2>/dev/null )
  say "sparse-after-checkout" "$(sizes "$OUT/sparse")  files=$(cd "$OUT/sparse" && git ls-files 2>/dev/null | wc -l | tr -d ' ') on-disk=$(find "$OUT/sparse" -type f -not -path '*/.git/*' 2>/dev/null | wc -l | tr -d ' ')"
fi

# ------------------------------------- what a partial clone takes away
# Decision 16 puts file contents behind just-in-time retrieval, so an agent that
# cannot read a blob it does not own is materially worse off. Test with the
# network deliberately unreachable, which is how a Codex worker runs.
if [ -d "$OUT/blobless/.git" ]; then
  BLOB=$(cd "$OUT/blobless" && git ls-files | grep -E '\.ts$' | head -1)
  ( cd "$OUT/blobless" && git cat-file -p "HEAD:$BLOB" > /dev/null 2> "$OUT/blob-online.err" )
  say "partial: read a blob (online)" "$([ $? -eq 0 ] && echo OK || echo "FAILED $(head -c 120 "$OUT/blob-online.err")")"

  # Point the promisor remote at a dead address: the fetch must fail, not hang.
  ( cd "$OUT/blobless" && git config remote.origin.url "file:///nonexistent-promisor" \
      && git config --unset-all remote.origin.promisor 2>/dev/null
    git -C "$OUT/blobless" cat-file -p "HEAD:$(cd "$OUT/blobless" && git ls-files | grep -E '\.ts$' | sed -n '2p')" > /dev/null 2> "$OUT/blob-offline.err" )
  if [ -s "$OUT/blob-offline.err" ]; then
    say "partial: read a blob (offline)" "FAILED — $(head -c 150 "$OUT/blob-offline.err" | tr '\n' ' ')"
  else
    say "partial: read a blob (offline)" "OK (blob was already local — inconclusive for on-demand fetch)"
  fi
  # Negative control: grep across files it does not have locally.
  ( cd "$OUT/blobless" && git grep -l "function" -- '*.ts' > /dev/null 2> "$OUT/grep-offline.err" )
  say "partial: git grep (offline)" "$([ -s "$OUT/grep-offline.err" ] && echo "FAILED — $(head -c 150 "$OUT/grep-offline.err" | tr '\n' ' ')" || echo OK)"
fi

# ------------------------------------------------------------- the pool
# Decision 19 recycles clones with `git fetch && git checkout <ref>`. Is that
# reliably cheaper than a fresh clone, and what does a recycled clone carry over?
if [ -d "$OUT/full/.git" ]; then
  PREV=$(git -C "$SRC" rev-parse HEAD~50 2>/dev/null || git -C "$SRC" rev-parse HEAD)
  HEADREF=$(git -C "$SRC" rev-parse HEAD)

  # Dirty the recycled clone the way a worker would: an edit, an untracked file,
  # and gitignored build output.
  ( cd "$OUT/full" && echo "worker edit" >> README.md 2>/dev/null
    echo scratch > WORKER-UNTRACKED.txt
    mkdir -p node_modules/leftover && echo x > node_modules/leftover/big.bin )

  timed pool-checkout-back "$OUT/full" -- git -C "$OUT/full" checkout --quiet --force "$PREV"
  timed pool-checkout-head "$OUT/full" -- git -C "$OUT/full" checkout --quiet --force "$HEADREF"

  ( cd "$OUT/full" && git status --short > "$OUT/pool-residue.txt" 2>&1 )
  say "pool: residue after checkout -f" "$(wc -l < "$OUT/pool-residue.txt" | tr -d ' ') entries — $(head -3 "$OUT/pool-residue.txt" | tr '\n' ' ' | cut -c1-90)"

  timed pool-clean-fdx "$OUT/full" -- git -C "$OUT/full" clean -fdx --quiet
  ( cd "$OUT/full" && git status --short > "$OUT/pool-residue2.txt" 2>&1 )
  say "pool: residue after clean -fdx" "$(wc -l < "$OUT/pool-residue2.txt" | tr -d ' ') entries"
fi

echo DONE
