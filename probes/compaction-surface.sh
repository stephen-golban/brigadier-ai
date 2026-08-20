#!/usr/bin/env bash
# Probe — ticket #47. Does every vendor compact, can brigadier TELL, and is the
# threshold settable at spawn?
#
# #22 measured compaction on Claude Code only, where the constraints survived
# because the host pins an explicit `preserved_segment`. Assuming the rest do the
# same is the generalisation this repo keeps paying for, and the stake is a
# binary outcome: arXiv 2606.22528 measures violation at 0% when the constraint
# survives the summary and 38% when it is dropped.
#
# This is the static half — what each shipped package contains — and it answers
# the two questions that do not need a turn:
#
#   "can brigadier even tell?"   is there an observable event or telemetry name
#   "can we pin the threshold?"  is there a config key or env var at spawn
#
# It is deliberately NOT proof of behaviour. A string in a bundle is evidence
# that a mechanism exists, not that it fires — the map already paid for that
# distinction once with `CLAUDE_ACP_*`, which was documented, believed, and had
# zero occurrences in the shipped code. Every count below is a pointer to go and
# drive, not a finding on its own.
#
# --no-ignore is LOAD-BEARING. Without it ripgrep honours the ignore files that
# npm packages ship, and silently skipped @github/copilot's real code — which
# lives in a nested platform package (`copilot-darwin-arm64/app.js`). The first
# run of this probe scored Copilot 0 on every axis and would have been reported
# as "Copilot does not compact". It compacts: 94 occurrences of `compaction`,
# including `compactionProcessor` and `compactHistory`.
#
# Usage: bash probes/compaction-surface.sh
set -uo pipefail

# Global `node_modules`, asked for rather than pasted. Under nvm this path is
# version-scoped (`.../versions/node/<ver>/lib/node_modules`), so a hard-coded
# one names somebody's home directory AND goes stale on the next node upgrade.
# The counts in the header above were read off the globally installed packages
# of one macOS developer machine; `npm root -g` is how they were located.
NM="${NODE_MODULES:-$(npm root -g 2>/dev/null)}"
CODEX_ACP="${CODEX_ACP:-$(find "$HOME/.npm/_npx" -maxdepth 5 -type d -path '*@agentclientprotocol/codex-acp' 2>/dev/null | head -1)}"
CLAUDE_ACP="${CLAUDE_ACP:-$(find "$HOME/.npm/_npx" -maxdepth 5 -type d -path '*@agentclientprotocol/claude-agent-acp' 2>/dev/null | head -1)}"

AGENTS=(
  "claude-acp:$CLAUDE_ACP"
  "codex-acp:$CODEX_ACP"
  "opencode:$NM/opencode-ai"
  "qwen:$NM/@qwen-code/qwen-code"
  "gemini:$NM/@google/gemini-cli"
  "copilot:$NM/@github/copilot"
)

count () { # count <dir> <regex>
  local d="$1" re="$2" n
  [ -d "$d" ] || { echo "-"; return; }
  n=$(timeout 300 rg -c --no-filename -a --no-ignore --hidden "$re" "$d" 2>/dev/null | paste -sd+ - | bc 2>/dev/null)
  echo "${n:-0}"
}

first () { # first <dir> <regex> — one representative match, for the evidence trail
  local d="$1" re="$2"
  [ -d "$d" ] || { echo ""; return; }
  timeout 300 rg -o --no-filename -a --no-ignore --hidden "$re" "$d" 2>/dev/null | sort -u | head -1
}

printf '%-12s %-9s %-9s %-11s %-11s %s\n' agent compacts event threshold preserved sample
printf '%-12s %-9s %-9s %-11s %-11s %s\n' ------ -------- ------- --------- --------- ------
for spec in "${AGENTS[@]}"; do
  name="${spec%%:*}"; dir="${spec#*:}"
  if [ ! -d "$dir" ]; then
    printf '%-12s %s\n' "$name" "PACKAGE NOT FOUND — not measured, not a pass"
    continue
  fi
  compacts=$(count "$dir" '(compact|compaction|compress the (chat|context)|summariz)')
  event=$(count "$dir" '(compact_boundary|EVENT_CHAT_COMPRESSION|CONTEXT_COMPACTION_META|chatCompression|compactionEvent)')
  thresh=$(count "$dir" '(AUTO_COMPACT_WINDOW|autoCompactThreshold|contextPercentageThreshold|COMPRESSION_TOKEN_THRESHOLD|compactionThreshold)')
  preserved=$(count "$dir" '(preserved_segment|preservedMessages|pinned|keep_?recent|preserve_?recent)')
  sample=$(first "$dir" '(compact_boundary|EVENT_CHAT_COMPRESSION|CONTEXT_COMPACTION_META|contextPercentageThreshold|COMPRESSION_TOKEN_THRESHOLD|preserved_segment)')
  printf '%-12s %-9s %-9s %-11s %-11s %s\n' "$name" "$compacts" "$event" "$thresh" "$preserved" "${sample:0:40}"
done

echo
echo "--- reading ---"
echo "compacts>0 means the mechanism is present in the shipped package."
echo "event>0 is a pointer to a name that MIGHT be observable — it must be driven to confirm,"
echo "        and on Claude the equivalent reaches only stream-json, never ACP (#22)."
echo "threshold>0 means there is something to pin at spawn."
echo "A zero is 'not found by this search', which is weaker than 'absent'. Neither is a pass."
