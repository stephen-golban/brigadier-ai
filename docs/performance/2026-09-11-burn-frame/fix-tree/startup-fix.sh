#!/bin/zsh
set -u
W=/private/tmp/brig-frame-20260911
SRC=/Users/stephen/Development/brigadier-ai.worktrees/fix-2026-09-11
ARM="$1"; LABEL="$2"; RUNS="${3:-10}"
DATA="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
"$W/resetdata.sh" > /dev/null
rm -f "$W/out-fix/startup-$LABEL.json"
LOAD_BEFORE=$(sysctl -n vm.loadavg | awk '{print $2}')
PG_BEFORE=$(pgrep -f "cargo build|tauri build|vite|cargo test|clippy|vitest|rustc" | wc -l | tr -d ' ')
cd "$SRC" || exit 90
python3 scripts/measure-native-startup.py "$W/frozen-$ARM.app/Contents/MacOS/brigadier" \
  --activate-helper "$W/activate-native-benchmark" \
  --paint-log "$DATA/paint.ndjson" \
  --output "$W/out-fix/startup-$LABEL.json" --runs "$RUNS" > "$W/out-fix/startup-$LABEL.stdout" 2>&1
CODE=$?
LOAD_AFTER=$(sysctl -n vm.loadavg | awk '{print $2}')
echo "startup_label=$LABEL arm=$ARM exit=$CODE runs=$RUNS pgrep_before=$PG_BEFORE load_before=$LOAD_BEFORE load_after=$LOAD_AFTER" > "$W/out-fix/startup-$LABEL.exit"
cat "$W/out-fix/startup-$LABEL.exit"
exit $CODE
