# probes/

Throwaway measurement scripts. **Not product code** — brigadier v2 has no source yet, and
decision 1 (true zero) means none of v1 is carried. These exist so a measurement can be
re-run and disputed rather than trusted from a written record.

Every result belongs in a comment on the ticket it answers, recorded as
**"MEASURED against `<tool> <version>` on `<date>`"** — never in the present tense. v1
recorded codex-cli moving 0.145.0 → 0.147.0 mid-project, which made every present-tense
claim version-stale while measured-against statements stayed true forever.

## `acp-handshake.ts`

Minimal ACP client: spawns an agent as a subprocess, speaks newline-delimited JSON-RPC 2.0
on its stdio, sends `initialize`, prints the response, kills the child.

```sh
bun probes/acp-handshake.ts <deadline-ms> <command> [args...]

bun probes/acp-handshake.ts 90000 npx -y @agentclientprotocol/claude-agent-acp
bun probes/acp-handshake.ts 120000 npx -y @agentclientprotocol/codex-acp
```

It kills the child on the first answered request and enforces a hard deadline, because agent
CLIs do not reliably exit on their own. **Exit 137 is the deliberate SIGKILL, not a failure.**
