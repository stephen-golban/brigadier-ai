#!/bin/zsh
set -u
D="$HOME/Library/Application Support/ai.brigadier.perf.cssspike"
rm -rf "$D"; mkdir -p "$D"
printf '%s\n' '{"displayName":"Performance Fixture","nameConfirmed":true,"welcomeCompleted":true,"introSeen":true,"launchMusic":false}' > "$D/workbench.json"
rm -rf "$HOME/Library/WebKit/ai.brigadier.perf.cssspike" "$HOME/Library/Caches/ai.brigadier.perf.cssspike" "$HOME/Library/Preferences/ai.brigadier.perf.cssspike.plist"
echo "reset exit=$?"
