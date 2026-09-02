# Claude Code CLI stdio fixtures

Raw NDJSON captures of the Claude Code CLI's stdio protocol, one scenario per file pair
(`*.ndjson` = received from the CLI, `*.sent.ndjson` = sent to it, `*.stderr.txt` = captured
stderr). Captured 2026-09-02 with CLI version 2.1.257, model `claude-haiku-4-5`.

- `s1-handshake-and-turn` — control handshake + a plain user turn ("pong")
- `s2-can-use-tool-allow` — `canUseTool` hook allowing a Bash call
- `s3-can-use-tool-deny` — `canUseTool` hook denying a Bash call
- `s4-interrupt` — a long turn interrupted mid-stream
- `s5-resume` — resuming a prior session
- `s6-hook-callback` — a `PreToolUse` hook callback round-trip
- `s7-kill` — process killed mid-turn

Account and path fields were scrubbed before commit: every email, organization name, home
directory and scratchpad path was replaced with a placeholder (`user@example.com`,
`/Users/example`, `/tmp/spike-scratch`). Session ids, tool_use ids, request ids, and message
uuids are untouched (needed for correlation tests).
