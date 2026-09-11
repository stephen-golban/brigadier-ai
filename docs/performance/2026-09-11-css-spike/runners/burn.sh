#!/bin/zsh
# usage: burn.sh <label>
set -u
SP=/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad
LABEL="$1"
WT=/Users/stephen/Development/brigadier-ai.worktrees/codex-thread
DATA="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
BIN="$SP/spike-perf/frozen-$LABEL.app/Contents/MacOS/brigadier"
rm -f "$SP/spike-perf/burn-$LABEL.json"
cd "$WT" || exit 90
python3 scripts/measure-native-burn.py "$BIN" \
  --activate-helper "$SP/spike-perf/activate-native-benchmark" \
  --data-dir "$DATA" \
  --output "$SP/spike-perf/burn-$LABEL.json"
CODE=$?
echo "burn_label=$LABEL exit=$CODE" | tee "$SP/spike-perf/burn-$LABEL.exit"
exit $CODE
