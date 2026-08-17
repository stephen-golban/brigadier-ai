#!/usr/bin/env bash
# Probe for #40 — is the "one unknown key discards the whole file" behaviour
# uniform across a plugin's manifests?
#
# #27 measured it for hooks/hooks.json. .mcp.json, .lsp.json and settings.json
# were never tested, and decision 27 puts brigadier's only hook surface in one of
# these files.
#
# Runs entirely under a scratch CLAUDE_CONFIG_DIR, so the operator's ~/.claude is
# never touched — decision 17's own lever, exercised incidentally.

set -uo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export CLAUDE_CONFIG_DIR="$WORK/config"
PLUGIN="$CLAUDE_CONFIG_DIR/skills/probeplug"
mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/hooks"

cat > "$PLUGIN/.claude-plugin/plugin.json" <<'JSON'
{ "name": "probeplug", "description": "probe for #40", "version": "0.0.1" }
JSON

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1));
  else echo "FAIL  $1"; echo "        expected: $2"; echo "        actual:   $3"; fail=$((fail+1)); fi
}
# The count AND the names. Ruling 60: a count alone is not a usable signal,
# because .lsp.json inflates it with unknown keys.
inventory() { # inventory <label> -> "N: name, name"
  claude plugin details probeplug 2>&1 \
    | grep -E "^ *$1 \([0-9]+\)" \
    | sed -E "s/^ *$1 \(([0-9]+)\) */\1: /; s/ *\(.*\)$//" \
    | head -1
}

echo "=== claude $(claude --version 2>/dev/null | awk '{print $1}') on $(uname -s) ==="
echo

echo "--- hooks/hooks.json: STRICT, and the discard is TOTAL ---"
hooks() { cat > "$PLUGIN/hooks/hooks.json"; }
H='[{ "hooks": [{"type":"command","command":"true"}] }]'
hooks <<JSON
{ "hooks": { "PreCompact": $H, "UserPromptSubmit": $H } }
JSON
check "two valid events register" "2" "$(inventory Hooks | cut -d: -f1)"
hooks <<JSON
{ "hooks": { "PreCompact": $H, "UserPromptSubmit": $H, "NotARealEvent": $H } }
JSON
check "ONE unknown event discards EVERY hook in the file" "0" "$(inventory Hooks | cut -d: -f1)"
hooks <<JSON
{ "hooks": { "PreCompact": $H }, "bogusTopLevel": 1 }
JSON
check "an unknown key OUTSIDE \`hooks\` is harmless" "1" "$(inventory Hooks | cut -d: -f1)"
hooks <<JSON
{ "hooks": { "PreCompact": [{ "hooks": [{"type":"command","command":"true","bogusField":1}] }] } }
JSON
check "an unknown FIELD on a valid hook is harmless" "1" "$(inventory Hooks | cut -d: -f1)"
printf '{ "hooks": { oops\n' > "$PLUGIN/hooks/hooks.json"
check "malformed JSON is also a silent zero" "0" "$(inventory Hooks | cut -d: -f1)"
hooks <<JSON
{ "hooks": { "PreCompact": $H } }
JSON
check "the names are printed, which is what a self-check must assert on" "1: PreCompact" \
  "$(inventory Hooks)"

echo
echo "--- .mcp.json: LENIENT, and it invents a server when the wrapper is absent ---"
cat > "$PLUGIN/.mcp.json" <<'JSON'
{ "mcpServers": { "one": { "command": "true" }, "two": { "command": "true" } } }
JSON
check "two valid servers" "2" "$(inventory 'MCP servers' | cut -d: -f1)"
cat > "$PLUGIN/.mcp.json" <<'JSON'
{ "mcpServers": { "one": { "command": "true" }, "two": { "command": "true" } }, "bogusTopLevel": 1 }
JSON
check "an unknown top-level key is IGNORED, not fatal" "2" "$(inventory 'MCP servers' | cut -d: -f1)"
cat > "$PLUGIN/.mcp.json" <<'JSON'
{ "bogusTopLevel": 1 }
JSON
check "but with no \`mcpServers\`, a bogus key COUNTS AS A SERVER" "1" \
  "$(inventory 'MCP servers' | cut -d: -f1)"
printf '{ "mcpServers": { oops\n' > "$PLUGIN/.mcp.json"
check "malformed JSON is a silent zero here too" "0" "$(inventory 'MCP servers' | cut -d: -f1)"
rm -f "$PLUGIN/.mcp.json"

echo
echo "--- .lsp.json: the top-level keys ARE the servers, and anything counts ---"
cat > "$PLUGIN/.lsp.json" <<'JSON'
{ "lspServers": { "one": { "command": "true", "extensions": ["ts"] } } }
JSON
check "a \`lspServers\` WRAPPER is itself counted as a server named lspServers" "1: lspServers" \
  "$(inventory 'LSP servers')"
cat > "$PLUGIN/.lsp.json" <<'JSON'
{ "lspServers": { "one": { "command": "true", "extensions": ["ts"] } }, "notARealKey": 1 }
JSON
check "an unknown key becomes a SECOND phantom server" "2: lspServers, notARealKey" \
  "$(inventory 'LSP servers')"
cat > "$PLUGIN/.lsp.json" <<'JSON'
{ "notARealKey": 1 }
JSON
check "garbage alone reports a healthy-looking count of 1" "1: notARealKey" \
  "$(inventory 'LSP servers')"
printf '{ oops\n' > "$PLUGIN/.lsp.json"
check "malformed JSON is a silent zero" "0" "$(inventory 'LSP servers' | cut -d: -f1)"
rm -f "$PLUGIN/.lsp.json"

echo
echo "=== $pass passed, $fail failed ==="
echo
echo "Three manifests, three behaviours, and the two silent failures point in"
echo "OPPOSITE directions: hooks.json drops everything on one unknown key, and"
echo ".lsp.json accepts anything and counts it. A generic \"did my plugin load\""
echo "check cannot be written; each manifest needs its own expected NAMES."
[ "$fail" -eq 0 ]
