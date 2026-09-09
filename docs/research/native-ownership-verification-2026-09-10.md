# Native ownership verification follow-up — 2026-09-10

Native checks began on the installed app built from main `1846f8b`; follow-up builds include the fixes below:

- The app starts and the saved legacy transcript repair removes the proven orphan stream row while retaining the completed row.
- Claude Ask mode initially asks permission for `ToolSearch` selecting exact Brigadier MCP schemas. The fix preauthorizes only an exact `select:` list of known app tools; unrelated discovery retains the selected policy.
- A Codex research worker uses `approvalPolicy=never` plus a read-only sandbox. Native MCP approval rejects even `request_owner` before the app can enforce its worker allowlist. The app-owned injected server now sets `default_tools_approval_mode=approve`; other servers and the read-only sandbox stay unchanged.
- A completed worker summary reports `status=completed`; completion receipt suppression previously recognized only `Idle` and `exited`. This allowed an unnecessary second root turn after the result was already read. Terminal assignment states now count as observed once the final result page is read.
- Narrow Context clipped the stopped/failed summary. The summary now wraps inside Context.

- Separate chats inherited the creator checkpoint and worker routing instructions. Only internal workers now inherit that context; ordinary chats receive their own requested prompt.
- A completed reply could remain a visible prefix while Copy and SQLite already held the full text. The Elements Markdown primitive defaults to a second typewriter reveal using animation frames. WKWebView can pause those frames. Disable that reveal for the durable transcript while retaining deferred Markdown parsing. A regression freezes animation frames, replaces partial text with the completed reply, and checks two distinct identical replies; it fails before the change and passes afterward.

Primary sources checked before the Codex configuration change:

- [Official MCP configuration](https://developers.openai.com/codex/mcp): server-scoped `default_tools_approval_mode` and per-tool overrides.
- [OpenAI Codex MCP call implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs): `AppToolApproval::Approve` does not require a native MCP approval prompt. `auto` uses tool annotations and is not unconditional approval.

These findings are failures from the initial native run, not passing acceptance evidence. Verification after fixes is recorded in the delivery ledger.

Local primary implementation inspected for the text fix: `node_modules/@assistant-ui/react-markdown/src/primitives/MarkdownText.tsx` (`smooth=true` default), and `node_modules/@assistant-ui/react/src/utils/smooth/useSmooth.ts` (completed nonempty prefixes continue via `requestAnimationFrame`).
