#!/usr/bin/env bash
# Probe — ticket #45, parts 1 and 2. Are the two effort levers REAL or cosmetic?
#
# Decision 29 makes the (agent, model, effort) triple the routing unit and
# decision 30 caps effort at `high`. Both need a lever that actually moves the
# inference, and both levers currently rest on inference rather than evidence:
#
#   Codex   `session/set_model` with an effort-bearing id was ACCEPTED (#2) and
#           returned an empty result with no confirming notification. Acceptance
#           was proven; effect was not.
#   Claude  the bridge READS `MAX_THINKING_TOKENS` (#2). That it is usable as an
#           effort lever is an inference, and it is the only Claude-side effort
#           mechanism identified at all.
#
# The discriminator is behavioural, not the return value: a fixed reasoning-heavy
# prompt with no tools, and the volume of `agent_thought_chunk` the agent streams
# back plus the wall clock. A cosmetic lever produces the same numbers at both
# ends of its range; a real one does not.
#
# Negative controls, both required:
#   - an INVALID model id must produce a different outcome from a valid one, or
#     `set_model` accepting something proves nothing at all;
#   - each setting is run more than once, because a single sample cannot
#     distinguish a lever from ordinary run-to-run variance.
#
# Usage: bash probes/effort-lever.sh <scratch-dir> [reps]
set -uo pipefail

SCRATCH="${1:?usage: effort-lever.sh <scratch-dir> [reps]}"
REPS="${2:-2}"
PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SRC="$SCRATCH/src"
RESULTS="$SCRATCH/results"
mkdir -p "$RESULTS"

if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$SRC"
  ( cd "$SRC" && git init -q . && printf 'seed\n' > seed.txt && git add -A \
    && git -c user.email=probe@local -c user.name=probe commit -qm init ) >/dev/null
fi

# Tool-free on purpose. Tool use adds latency variance that has nothing to do
# with reasoning depth, and would swamp the signal being measured.
PROMPT="Do not use any tools, do not read or write any files, and do not run any commands. Answer from reasoning alone.

A 7x7 grid has a token on the top-left square. Each move goes one square right or one square down. Some squares are blocked: (2,3), (4,4), (5,2) and (3,6), using 1-based (row, column). How many distinct paths reach the bottom-right square? Show your reasoning, then give the final count on its own line."

record () {
  local label="$1" dir="$2"
  python3 - "$label" "$dir" <<'PY'
import json, sys, os
label, d = sys.argv[1], sys.argv[2]
p = os.path.join(d, "result.json")
if not os.path.exists(p):
    print(f"{label:34s} NO RESULT"); raise SystemExit
r = json.load(open(p))
err = r.get("error")
sm = r.get("setModel")
sm_err = (sm or {}).get("error") if isinstance(sm, dict) else None
print(f"{label:34s} promptMs={str(r.get('promptMs')):>7s} "
      f"thoughtChunks={str(r.get('thoughtChunks')):>4s} "
      f"thoughtChars={str(r.get('thoughtChars')):>7s} "
      f"msgChars={str(r.get('messageChars')):>6s} "
      f"stop={str(r.get('stopReason'))} "
      f"{'SETMODEL_ERR' if sm_err else ''}{' TURN_ERR' if err else ''}")
PY
}

echo "==================== CODEX: session/set_model ===================="
codex --version
for model in "gpt-5.6-sol[low]" "gpt-5.6-sol[xhigh]" "gpt-5.6-nonexistent[low]" ""; do
  for rep in $(seq 1 "$REPS"); do
    tag=$(echo "${model:-DEFAULT}" | tr -c 'a-zA-Z0-9' '-')
    name="codex-$tag-$rep"
    lane="$SCRATCH/lane-$name"; dir="$RESULTS/$name"
    rm -rf "$lane" "$dir"; git clone -q --local "$SRC" "$lane"; mkdir -p "$dir"

    if [ -n "$model" ]; then
      INITIAL_AGENT_MODE=read-only bun "$PROBE_DIR/acp-session.ts" \
        --cwd "$lane" --out "$dir" --policy deny --deadline 400000 \
        --model "$model" --prompt "$PROMPT" \
        -- npx -y @agentclientprotocol/codex-acp > "$dir/stdout.log" 2>&1
    else
      INITIAL_AGENT_MODE=read-only bun "$PROBE_DIR/acp-session.ts" \
        --cwd "$lane" --out "$dir" --policy deny --deadline 400000 \
        --prompt "$PROMPT" \
        -- npx -y @agentclientprotocol/codex-acp > "$dir/stdout.log" 2>&1
    fi
    record "codex ${model:-<default gpt-5.6-sol[high]>} #$rep" "$dir"
  done
done

echo
echo "============= CLAUDE: MAX_THINKING_TOKENS ============="
claude --version
for mtt in 0 4000 32000; do
  for rep in $(seq 1 "$REPS"); do
    name="claude-mtt$mtt-$rep"
    lane="$SCRATCH/lane-$name"; dir="$RESULTS/$name"
    rm -rf "$lane" "$dir"; git clone -q --local "$SRC" "$lane"; mkdir -p "$dir"

    MAX_THINKING_TOKENS="$mtt" bun "$PROBE_DIR/acp-session.ts" \
      --cwd "$lane" --out "$dir" --policy deny --deadline 400000 \
      --prompt "$PROMPT" \
      -- npx -y @agentclientprotocol/claude-agent-acp > "$dir/stdout.log" 2>&1
    record "claude MAX_THINKING_TOKENS=$mtt #$rep" "$dir"
  done
done

echo
echo "--- reading ---"
echo "A lever is REAL if thoughtChars/promptMs separate cleanly between its ends across reps."
echo "The invalid-model row is the control: if it behaves identically to a valid one, then"
echo "set_model's acceptance carries no information and neither does any row above it."
