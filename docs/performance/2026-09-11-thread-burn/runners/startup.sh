#!/bin/zsh
set -u
W=/private/tmp/brig-burn-20260911
BR=/Users/stephen/Development/brigadier-ai.worktrees/codex-thread
ARM="$1"; LABEL="$2"; RUNS="${3:-10}"
DATA="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
rm -f "$W/out/startup-$LABEL.json"
cd "$BR" || exit 90
python3 scripts/measure-native-startup.py "$W/frozen-$ARM.app/Contents/MacOS/brigadier" \
  --activate-helper "$W/activate-native-benchmark" \
  --paint-log "$DATA/paint.ndjson" \
  --output "$W/out/startup-$LABEL.json" --runs "$RUNS" > "$W/out/startup-$LABEL.stdout" 2>&1
CODE=$?
echo "startup_label=$LABEL arm=$ARM exit=$CODE" > "$W/out/startup-$LABEL.exit"
cat "$W/out/startup-$LABEL.exit"
exit $CODE
