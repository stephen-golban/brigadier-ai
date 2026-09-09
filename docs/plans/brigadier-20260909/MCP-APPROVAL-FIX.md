# Native Codex MCP approval correction

Reported during installed-app verification on 2026-09-09. Scope is the Codex approval adapter and its existing UI contract; packaging/reinstall is owned by the source task.

## Failure and protocol evidence

Native session `545e2b81-c5e7-4c22-bb12-9394e6564864` recorded unsupported `mcpServer/elicitation/request` at seq85/94/100. These requests are marked `_meta.codex_approval_kind = "mcp_tool_call"`, `mode = "form"`, with `requestedSchema = {"type":"object","properties":{}}`. The native request includes server name, confirmation message, tool description and tool parameters. It offers persistence metadata; this integration does not apply that metadata or modify configuration.

The command/file approval response uses `result.decision`. The MCP elicitation response instead uses `result.action` with `accept`, `decline`, or `cancel`, and `content` containing the accepted empty object or null for rejection/cancellation. Verified against the installed CLI-generated `McpServerElicitationRequestResponse.json` and `ServerRequestResolvedNotification.json` in `/tmp/brigadier-codex-json-schema`, plus [official app-server documentation](https://learn.chatgpt.com/docs/app-server#approvals).

Native verification also found a stopped Edit approval remaining actionable. Previously actor teardown called the approval broker's cancellation method after leaving the loop; it no longer consumed the resulting decisions and therefore did not emit the durable `RequestResolved` signals needed by persistence and UI.

## Implemented correction

Recognize only the marked empty-form MCP tool-approval shape scoped to the active native thread/turn. Use the existing visible approval card with `MCP · brigadier`, native confirmation/details, and explicit per-request Allow/Deny. Do not infer executable tool identity from message prose. Keep scoped hook denial and never grant session/global permissions. Generic form, URL, unknown and malformed elicitations remain unsupported rather than becoming blanket approvals.

Track native request identity separately from the app's approval ID. Clear request records on native resolution, turn cancellation and session exit; emit durable cancellation resolutions before terminating so late answers cannot revive them and stopped approvals disappear from attention state.

Keep the request registered until its native reply is written successfully. If delivery fails, teardown closes the durable prompt with an explicit unconfirmed-delivery reason. Queued Stop takes priority over an undelivered Allow.

## Verification

- Approval UI/feed tests: 33 passed. They cover visible native confirmation, explicit per-request Allow with no permission updates, Deny, expired request refusal, and removal of MCP/Edit requests when Stop resolutions arrive.
- TypeScript no-emit check: passed.
- Codex adapter suite: 17 passed, 2 opt-in live tests ignored. Coverage includes native numeric/string request IDs and exact response schema, Allow/Deny/cancel, unknown/malformed/URL requests, stale thread/turn, policy denial, provider-cleared/duplicate requests, Interrupt, Kill/End with pending MCP/Edit, queued Stop versus Allow, and failed reply delivery.
- Store approval suite: 4 passed, including the historical stopped-session sequence without a resolution. Restart expires those rows and preserves their audit history without inventing a Deny decision; existing recovery implementation needed no change.
- Whitespace validation: `git diff --check` passed.
- Packaging/native re-verification: pending the source task's rebuild and reinstall.

The related command seq83 in the reported session had exitCode0 and Xcode/git sandbox cache/temp warnings. No `rg` missing-command line was found in that session's recorded output; shell configuration was not changed.
