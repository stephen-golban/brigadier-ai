#!/bin/zsh
# usage: build.sh <label>
set -u
SP=/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad
LABEL="$1"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$SP/spike-target"
cd /Users/stephen/Development/brigadier-ai.worktrees/codex-thread || exit 90
START=$(date +%s)
VITE_BURN=1 npm run tauri build -- --features burn \
  --config "$SP/spike-perf/tauri.json" --bundles app \
  > "$SP/spike-perf/build-$LABEL.log" 2>&1
CODE=$?
END=$(date +%s)
echo "build_label=$LABEL exit=$CODE seconds=$((END-START))" | tee "$SP/spike-perf/build-$LABEL.exit"
exit $CODE
