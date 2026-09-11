#!/bin/zsh
set -u
W=/private/tmp/brig-frame-20260911
SRC=/Users/stephen/Development/brigadier-ai.worktrees/burn-2026-09-11
ARM="$1"; LABEL="$2"
DATA="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
"$W/resetdata.sh" > /dev/null
rm -f "$W/out/burn-$LABEL.json"
LOCKS_BEFORE=$(ls "$HOME/.brigadier/workspace-locks-v1" 2>/dev/null | wc -l | tr -d ' ')
PG_BEFORE=$(pgrep -f "cargo build|tauri build|vite|cargo test|clippy|vitest|rustc" | wc -l | tr -d ' ')
LOAD_BEFORE=$(sysctl -n vm.loadavg | awk '{print $2}')
cd "$SRC" || exit 90
python3 scripts/measure-native-burn.py "$W/frozen-$ARM.app/Contents/MacOS/brigadier" \
  --activate-helper "$W/activate-native-benchmark" \
  --data-dir "$DATA" \
  --output "$W/out/burn-$LABEL.json" > "$W/out/burn-$LABEL.stdout" 2>&1
CODE=$?
PG_AFTER=$(pgrep -f "cargo build|tauri build|vite|cargo test|clippy|vitest|rustc" | wc -l | tr -d ' ')
LOCKS_AFTER=$(ls "$HOME/.brigadier/workspace-locks-v1" 2>/dev/null | wc -l | tr -d ' ')
LOAD_AFTER=$(sysctl -n vm.loadavg | awk '{print $2}')
echo "burn_label=$LABEL arm=$ARM exit=$CODE pgrep_before=$PG_BEFORE pgrep_after=$PG_AFTER load_before=$LOAD_BEFORE load_after=$LOAD_AFTER locks_before=$LOCKS_BEFORE locks_after=$LOCKS_AFTER" > "$W/out/burn-$LABEL.exit"
cat "$W/out/burn-$LABEL.exit"
exit $CODE
