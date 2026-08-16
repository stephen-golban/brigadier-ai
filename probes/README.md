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
| `treesitter/` | #23 | Can `bun build --compile` embed and load a tree-sitter `.wasm` grammar? |
| `windows/portability.ts` | #5 | Hardlinks, `MAX_PATH`, CRLF, symlinks, `PATHEXT` — measured per platform. |
| `windows/jobobject-tree.ts` | #5 | Does killing a spawned child kill its grandchildren? |

## Running them

```
bun probes/acp-handshake.ts 60000 npx -y @agentclientprotocol/claude-agent-acp
bun probes/windows/portability.ts /tmp/scratch
bun probes/windows/jobobject-tree.ts --group

cd probes/treesitter && npm install && bun grammars.ts
```

The tree-sitter probe pins both its runtime and its grammars. They must come from the same
tree-sitter ABI; a mismatched pair fails inside Emscripten's dynamic-link loader with a bare
`Error` and no message, which reads exactly like "WASM does not work here" and is not that.

`.github/workflows/portability.yml` runs the `windows/` and `treesitter/` probes on
`windows-latest`, `ubuntu-latest` and `macos-latest`, because a Windows result with no control
column is not a measurement.
