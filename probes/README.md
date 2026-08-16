# probes/

Throwaway measurement scripts. **Not product code**, not held to product standards, and not the
beginning of a codebase — see `AGENTS.md`. Each one exists to turn one assumption on the wayfinder
map into evidence, and each names the ticket it serves.

Every probe follows the same two rules the map insists on: it prints what it measured rather than a
verdict it inferred, and where it makes a claim it also shows the check *failing* when it should.

| probe | ticket | question |
| --- | --- | --- |
| `acp-handshake.ts` | #14, #2 | What does an agent's ACP `initialize` actually return? |
| `acp-session.ts` | #14, #3 | A full turn: `session/new` in a clone, a prompt, permissions, a diff. |
| `acp-agent-shim.ts` | #6 | The smallest thing that *is* an ACP agent, fanning out inside one turn. |
| `quota-signals.ts` | #15 | Is there a quota signal outside ACP, and does it survive the bridge? |
| `large-repo.sh` | #19 | Clone economics on 81,368 files: `--local`, `--filter`, sparse, the pool. |
| `treesitter/grammars.ts` | #23 | Can `bun build --compile` embed and load a tree-sitter `.wasm` grammar? |
| `treesitter/repomap.ts` | #23 | A rough Aider-style repo map: parse → exports → PageRank → token budget. |
| `windows/portability.ts` | #5 | Hardlinks, `MAX_PATH`, CRLF, symlinks, `PATHEXT` — measured per platform. |
| `windows/jobobject-tree.ts` | #5 | Does killing a spawned child kill its grandchildren? |

## Running them

```
bun probes/acp-handshake.ts 60000 npx -y @agentclientprotocol/claude-agent-acp
bun probes/acp-session.ts --cwd <clone> --out <dir> --policy lane --mode default \
    -- npx -y @agentclientprotocol/claude-agent-acp
bun probes/acp-session.ts --cwd <clone> --out <dir> \
    -- bun probes/acp-agent-shim.ts --slices 3 --forward-permission
bun probes/quota-signals.ts 90000 codex app-server
bash probes/large-repo.sh <big-repo> /tmp/scratch

bun probes/windows/portability.ts /tmp/scratch
bun probes/windows/jobobject-tree.ts --group

cd probes/treesitter && npm install && bun grammars.ts
cd probes/treesitter && bun repomap.ts <repo> 1024 --emit
```

## Two things measured here that other probes will need

**The `CLAUDE_CODE_EXECUTABLE` shim** is the general configuration seam for the Claude bridge (#4).
The bridge `exec`s whatever that variable names, so a three-line script can append a flag the bridge
does not forward, or tee the raw `stream-json` channel — which is how #15 recovered the
`rate_limit_event` and #22 recovered the `compact_boundary` telemetry. Neither reaches ACP.

**`du` on a clone directory counts hardlinked objects** and reports a full copy that does not exist.
Incremental disk needs a single `du -scm <source> <clone>`, which counts shared inodes once. This is
the difference between "a clone costs 3.5 GB" and "a clone costs 0 MB" (#19).

The tree-sitter probe pins both its runtime and its grammars. They must come from the same
tree-sitter ABI; a mismatched pair fails inside Emscripten's dynamic-link loader with a bare
`Error` and no message, which reads exactly like "WASM does not work here" and is not that.

`.github/workflows/portability.yml` runs the `windows/` and `treesitter/` probes on
`windows-latest`, `ubuntu-latest` and `macos-latest`, because a Windows result with no control
column is not a measurement.
