#!/usr/bin/env bash
# Probe — ticket #44. Does the repo map's effect hold ACROSS VENDORS?
#
# #23 measured the A/B on one repository with one agent (Claude Code) and got
# large effects in opposite directions depending on whether the target was in
# the map. Its stated hypothesis was that agents which already index benefit
# least — but only Claude was driven, so the hypothesis was never tested.
#
# This replays #23's exact two tasks, on its exact repository, against BOTH
# vendors, changing one variable at a time:
#
#   Task A  target IS in the map      "Which file defines the warning logger?"
#   Task B  target is NOT in the map  "Which file converts a canvas design to SVG?"
#   arm     map prepended to the prompt, or not
#
# If the benefit is Claude-only, the map is a per-vendor optimisation and belongs
# in the launch-profile table, NOT in the byte-identical brief decision 16
# specifies — which would put rulings 16 and 22 in direct conflict.
#
# Usage: bash probes/repomap-ab.sh <repo> <scratch-dir> [reps]
set -uo pipefail

REPO="${1:?usage: repomap-ab.sh <repo> <scratch-dir> [reps]}"
SCRATCH="${2:?usage: repomap-ab.sh <repo> <scratch-dir> [reps]}"
REPS="${3:-2}"
PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS="$SCRATCH/results"
mkdir -p "$RESULTS"

TASK_A="Which file defines the warning logger? Answer with the file path only."
TASK_B="Which file converts a canvas design to SVG? Answer with the file path only."

# Build the map once, at ruling 22's ~1K budget, exactly as #23 did.
MAP="$SCRATCH/map.txt"
if [ ! -s "$MAP" ]; then
  ( cd "$PROBE_DIR/treesitter" && bun repomap.ts "$REPO" 1024 --emit ) > "$MAP" 2>"$SCRATCH/map.err"
fi
echo "map: $(wc -c < "$MAP") chars, $(grep -c ':$' "$MAP") files"
echo

run_cell () {
  local vendor="$1" task="$2" arm="$3" rep="$4"
  local name="$vendor-$task-$arm-$rep"
  local lane="$SCRATCH/lane-$name" dir="$RESULTS/$name"
  rm -rf "$lane" "$dir"; mkdir -p "$dir"
  git clone -q --local "$REPO" "$lane"

  local question; [ "$task" = "A" ] && question="$TASK_A" || question="$TASK_B"
  local prompt="$question"
  if [ "$arm" = "map" ]; then
    prompt="Here is a map of the repository — file paths and the symbols they export.

$(cat "$MAP")

$question"
  fi

  local cmd
  if [ "$vendor" = "claude" ]; then cmd=(npx -y @agentclientprotocol/claude-agent-acp)
  else cmd=(npx -y @agentclientprotocol/codex-acp); fi

  bun "$PROBE_DIR/acp-session.ts" --cwd "$lane" --out "$dir" \
    --policy allow --deadline 300000 --prompt "$prompt" \
    -- "${cmd[@]}" > "$dir/stdout.log" 2>&1

  python3 - "$name" "$dir" <<'PY'
import json, sys, os
name, d = sys.argv[1], sys.argv[2]
p = os.path.join(d, "result.json")
if not os.path.exists(p):
    print(f"{name:34s} NO RESULT"); raise SystemExit
r = json.load(open(p))
print(f"{name:34s} toolCalls={str(len(r.get('toolCalls') or [])):>3} "
      f"ms={str(r.get('promptMs')):>7} agentBytes={str(r.get('transcriptChars')):>8} "
      f"msgChars={str(r.get('messageChars')):>5} stop={r.get('stopReason')}")
# The answer itself, so a cheaper arm that got it WRONG is not read as a win.
notes = os.path.join(d, "notes.log")
PY
  # Correctness is not optional here: an arm that explores less because it
  # answered wrongly is not a saving. Record what it actually said.
  python3 - "$dir" <<'PY'
import json, sys, os
d = sys.argv[1]
p = os.path.join(d, "transcript.jsonl")
txt = []
if os.path.exists(p):
    for line in open(p, errors="replace"):
        try: m = json.loads(line)
        except: continue
        raw = m.get("raw")
        if not raw: continue
        try: o = json.loads(raw)
        except: continue
        u = (o.get("params") or {}).get("update") or {}
        if u.get("sessionUpdate") == "agent_message_chunk":
            txt.append((u.get("content") or {}).get("text", ""))
answer = "".join(txt).strip().replace("\n", " ")[:150]
print(f"{'':34s} answer: {answer}")
PY
}

for vendor in claude codex; do
  echo "=================== $vendor ==================="
  for task in A B; do
    for arm in nomap map; do
      for rep in $(seq 1 "$REPS"); do
        run_cell "$vendor" "$task" "$arm" "$rep"
      done
    done
  done
  echo
done

echo "--- reading ---"
echo "Task A is #23's case A (target in the map): the map should cut tool calls to ~0."
echo "Task B is #23's case B (target absent): #23 measured the map making it WORSE on Claude."
echo "If codex's two arms barely differ, the map is a per-vendor optimisation and rulings"
echo "16 (byte-identical brief) and 22 (ship the map) are in conflict."
