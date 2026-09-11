#!/bin/zsh
set -u
W=/private/tmp/brig-burn-20260911
BR=/Users/stephen/Development/brigadier-ai.worktrees/codex-thread
ARM="$1"; LABEL="$2"
DATA="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
"$W/resetdata.sh"
rm -f "$W/out/burn-$LABEL.json"
cd "$BR" || exit 90
python3 scripts/measure-native-burn.py "$W/frozen-$ARM.app/Contents/MacOS/brigadier" \
  --activate-helper "$W/activate-native-benchmark" \
  --data-dir "$DATA" \
  --output "$W/out/burn-$LABEL.json" > "$W/out/burn-$LABEL.stdout" 2>&1
CODE=$?
echo "burn_label=$LABEL arm=$ARM exit=$CODE" > "$W/out/burn-$LABEL.exit"
cat "$W/out/burn-$LABEL.exit"
exit $CODE
