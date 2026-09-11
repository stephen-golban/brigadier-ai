#!/bin/zsh
# usage: freeze.sh <label>  -- snapshot the just-built bundle so later builds cannot replace it
set -u
SP=/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/14e67347-0897-4eec-9dd1-f6e922823da6/scratchpad
LABEL="$1"
rm -rf "$SP/spike-perf/frozen-$LABEL.app"
cp -Rc "$SP/spike-target/release/bundle/macos/Brigadier CssSpike.app" "$SP/spike-perf/frozen-$LABEL.app"
CODE=$?
echo "freeze_label=$LABEL exit=$CODE"
exit $CODE
