#!/bin/zsh
# usage: startup.sh <label> [runs]
set -u
SP=/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad
LABEL="$1"; RUNS="${2:-10}"
WT=/Users/stephen/Development/brigadier-ai.worktrees/codex-thread
DATA="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
BIN="$SP/spike-perf/frozen-$LABEL.app/Contents/MacOS/brigadier"
rm -f "$SP/spike-perf/startup-$LABEL.json"
cd "$WT" || exit 90
python3 scripts/measure-native-startup.py "$BIN" \
  --activate-helper "$SP/spike-perf/activate-native-benchmark" \
  --paint-log "$DATA/paint.ndjson" \
  --output "$SP/spike-perf/startup-$LABEL.json" --runs "$RUNS"
CODE=$?
echo "startup_label=$LABEL exit=$CODE" | tee "$SP/spike-perf/startup-$LABEL.exit"
exit $CODE
