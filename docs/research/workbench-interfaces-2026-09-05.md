# Workbench interface facts — 2026-09-05

Implementation research for the approved project tabs, editor, Source Control, search and commit-message phase. Primary documentation/source and existing recorded CLI fixtures were read; no model requests, repository mutations, or external publishing were performed. Source links to `main` describe the fetched revision, not a pinned release. Brigadier recommendations below are explicitly distinguished from reference behavior.

## VS Code Source Control

### Commit defaults and grouping

Verified in the [Git extension configuration source](https://github.com/microsoft/vscode/blob/main/extensions/git/package.json):

| Setting | Default | Consequence |
| --- | --- | --- |
| `git.enableSmartCommit` | `false` | No silent automatic stage-all by default |
| `git.suggestSmartCommit` | `true` | Offer stage-and-commit when nothing is staged |
| `git.smartCommitChanges` | `all` | Smart commit includes untracked files in mixed view |
| `git.untrackedChanges` | `mixed` | Untracked entries appear under Changes; `separate` and `hidden` are alternatives |
| `git.useEditorAsCommitInput` | `true` | Empty input can enter the commit-message editor flow |
| `git.alwaysShowStagedChangesResourceGroup` | `false` | Empty staged group need not remain visible |
| `git.allowForcePush` | `false` | Force push is an opt-in action |
| `git.useForcePushWithLease` | `true` | Configured force push prefers lease protection |
| `git.confirmForcePush` | `true` | Confirmation accompanies force push |

The [commit command implementation](https://github.com/microsoft/vscode/blob/main/extensions/git/src/commands.ts) asks whether to stage everything and commit when unstaged changes exist, nothing is staged, smart commit is disabled, and the operation is neither explicit Commit All nor Amend. Choices: **Yes**, **Always**, **Never**, plus dismissal. Yes enables it for this attempt; Always also saves the preference; Never disables subsequent suggestions and exits; dismissal exits. Smart commit uses staged changes when any exist. Separate/hidden untracked views turn its `all` option into tracked-only. With no changes, a distinct explicit empty-commit action is offered. Dirty editor documents also trigger a save-before-commit decision. These details rule out implementing the ordinary Commit button as universally disabled whenever staging is empty.

The [staging documentation](https://code.visualstudio.com/docs/sourcecontrol/staging-commits) establishes file/folder/all staging, file and selection unstaging, selectable flat/tree lists, status decorations, side-by-side and inline diffs, gutter actions, and **Stage Selected Ranges**. Commit normally includes staged content; Commit All is separate. Amend updates the last commit; Undo Last Commit retains its changes staged. An editable message field and explicit generation button are separate from the actual commit. File discard and diff-range revert are distinct operations. Documentation says discarded changes go to system Trash/Recycle Bin: irreversible deletion would not match that behavior.

**Source conflict:** that staging page says the AI co-author default is `chatAndAgent`; fetched Git configuration source says `off`. Do not resolve this by assumption. Brigadier's user explicitly chose attribution off, which controls our implementation regardless.

**Brigadier acceptance recommendation:** maintain independent staged and working-tree state for the same path; expose the appropriate comparison for each row; never recreate a partial-stage operation from an unvalidated stale diff. Preserve unstaged content when changing the index. A displayed hunk must correspond to exactly the patch submitted. Verify initial commits, deleted/new files, renamed paths, no-newline-at-EOF, binary files, and concurrent index edits.

### Wider behavior implied by “mimic VS Code”

| Area | Verified reference surface |
| --- | --- |
| Branches | Create/switch branches; merge and rebase; worktree operations. A linked worktree has its own files, staging area and uncommitted changes, while history/refs/remotes are shared. Git prevents simultaneous checkout of one local branch in different worktrees. |
| Stashes | Stash tracked, include untracked, or staged-only; optional message; inspect stash; apply/pop selected or latest; drop selected/all. Staged-only stash needs Git 2.35+. |

Source: [branches and worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees).

Remotes include fetch, fetch-all, prune fetch, pull, pull with rebase, push to a chosen remote, and publish branch when upstream is missing. **Sync performs pull then push**, with ahead/behind counts visible. Automatic fetch is disabled initially. Repositories view supports multiple repositories and associated worktrees. [Repositories and remotes](https://code.visualstudio.com/docs/sourcecontrol/repos-remotes).

History includes a branch graph, incoming/outgoing commits, changed files and diffs per commit, checkout/cherry-pick context actions, comparison against branches or merge base, file Timeline, and blame. A simple recent-commit list is useful but does not provide the full graph/timeline behavior. [Source control history](https://code.visualstudio.com/docs/sourcecontrol/history).

Conflicts have current/incoming/both/compare inline actions and a three-way editor with incoming, current, and editable result. Complete Merge stages the resolved file; merely deleting markers is not the same action. [Merge conflicts](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts).

**Scope limit:** this audit verifies major user-visible workflows, not every Git extension command, extension integration, authentication flow, shortcut, or setting. Do not label a smaller delivered surface “exact parity” without accounting for the remaining reference behavior. Native VS Code UI was not exercised during this research.

## Monaco in Vite / Tauri

Monaco is the reusable editor component, not the VS Code workbench or extension host. Models hold content, language and edit history independently from editor views. Unique, stable model URIs matter for TypeScript imports and JSON schema matching. VS Code extensions do not generally run unchanged in Monaco. Providers implement completion/hover and other smart features; worker setup is required for language services. [Monaco README](https://github.com/microsoft/monaco-editor/blob/main/README.md).

The official integration guide maps worker labels: `json` → JSON worker; `css/scss/less` → CSS; `html/handlebars/razor` → HTML; `javascript/typescript` → TypeScript; all others → editor worker. Configure `MonacoEnvironment.getWorker`, not only `getWorkerUrl`. [Monaco ESM integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md).

Vite supports static `?worker` imports returning constructors, or `new Worker(new URL(..., import.meta.url), { type: 'module' })`. The latter must keep `new URL` directly inside `new Worker` and use static option values for discovery. Production workers become separate emitted chunks by default. [Vite workers](https://vite.dev/guide/features#web-workers).

Verified locally in installed `node_modules/monaco-editor` (0.56.0 package selected by the implementation): language-service contribution entry points exist for TypeScript, JSON, CSS, and HTML. Basic-language tokenizers are a different layer. **Recommendation:** advertise IntelliSense for these supported services, syntax highlighting for other registered languages, and avoid claiming Rust/Python project intelligence without an additional language-server integration. JS/TS imports cannot automatically resolve arbitrary native filesystem dependencies: the host must expose the corresponding models/type declarations/configuration. Keep one model per tab identity and save/restore each view state. Unsaved tabs need stable synthetic URIs with a meaningful extension; disk saves should move to a canonical file URI without losing the buffer. Worker execution in the packaged Tauri webview still needs runtime verification, not only successful bundling.

## Rust project search and replacement

`ignore::WalkBuilder` supplies recursive iteration with `.gitignore`, `.git/info/exclude`, global Git excludes and `.ignore` support. Hidden-file filtering and parent ignore files are enabled by default; symlink following is disabled. Override patterns are checked before ignore files and can re-include ignored paths. `max_filesize` bounds files. [WalkBuilder](https://docs.rs/ignore/latest/ignore/struct.WalkBuilder.html).

`globset` matches sets of Unix-style patterns; `GlobBuilder::literal_separator(true)` prevents `*` and `?` from crossing path separators. `**` has position-sensitive rules. Brace alternatives are supported but nested alternatives are not. **Recommendation:** document whether a bare `*.ts` is basename-relative or root-relative, normalize separators, and test include/exclude precedence. Do not split comma-separated input blindly inside brace alternatives. [globset](https://docs.rs/globset/latest/globset/).

Rust `regex` deliberately excludes look-around and backreferences. Consequently it does not provide full VS Code/JavaScript regex compatibility. Return syntax errors visibly; never silently fall back to literal matching. Its documented single-search bound is O(pattern-size × haystack-size); repeated searches have separate complexity considerations. [regex](https://docs.rs/regex/latest/regex/). Replacement supports capture interpolation; literal replacement needs the literal/no-expansion path. [Regex API](https://docs.rs/regex/latest/regex/struct.Regex.html).

**Brigadier recommendation:** one search engine must produce both preview and replacement plans. Snapshot file identity/content, reject stale files at apply, use bounded reads/output and cancellation, and report skipped binary/oversized/unreadable files. Convert Rust byte offsets to Monaco's UTF-16 line/column coordinates explicitly. Preview must distinguish files and occurrence counts. Multi-file replace needs recovery/undo records and must not overwrite an open dirty editor without resolving its content. These are host responsibilities, not capabilities the three crates automatically supply.

## Claude model selection and commit-message generation

The existing app's `src-tauri/src/views.rs::models()` is a fixed list; `commands.rs::list_models` returns it. The existing direct adapter's initialize success path discards the successful response body (`crates/core/src/claude/adapter.rs`). Thus “available models of this CLI/session” is not yet accurately represented by that list.

Primary local evidence: the first frame of `crates/claude-spike/fixtures/s1-handshake-and-turn.ndjson` includes `response.response.models`, containing `value`, `resolvedModel`, `displayName`, `description`, and optional effort/adaptive/fast/auto capability fields. Its rows include default, Opus, Fable, Sonnet and Haiku. The previously downloaded Anthropic SDK's `sdk.d.ts` (see `docs/research/agent-sdk.md` for scratchpad provenance) defines `Query.supportedModels(): Promise<ModelInfo[]>` and the corresponding model fields. The SDK was read, not invoked. **Recommendation:** surface model metadata from initialization, scoped to driver account/project configuration, preserve selected wire IDs and resolved model IDs, and feature-detect optional fields.

CLI model aliases can be remapped by `ANTHROPIC_DEFAULT_*_MODEL`; `availableModels`, managed configuration, and organization restrictions affect allowed choices. A friendly alias is therefore not a universal pricing guarantee. [Claude model configuration](https://code.claude.com/docs/en/model-config).

Public first-party pricing currently places Haiku 4.5 at $1 input/$5 output per million tokens, below Sonnet 5 at $2/$10. Legacy Haiku 3.5 is cheaper where still available on selected third-party providers; provider billing can differ. Thus Auto should choose the cheapest **available model with known pricing**, not claim that any string containing `haiku` is universally cheapest. Subscription marginal costs and arbitrary gateway model prices are not established by the public table. [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).

For an isolated, one-off generation request, CLI supports `--tools ""` to disable built-in tools, `--strict-mcp-config` for the configured-only MCP set, `--no-session-persistence` in print mode, `--max-turns`, and `--max-budget-usd` in print mode. Allowed-tools is an auto-approval list, not a tool-removal mechanism. `--safe-mode` disables customizations while retaining authentication/model selection; version capability must be verified before relying on it. [CLI reference](https://code.claude.com/docs/en/cli-reference).

**Brigadier recommendation:** reuse direct-stdio lifecycle/parsing with an explicit utility request mode; do not inject commit-message generation into the active conversation. Supply only the selected diff, bound prompt/output and lifetime, disable tools/MCP, and deny any unexpected tool event. Existing `SpawnSpec` does not yet expose all utility flags; ordinary `default` permissions and its write-tool hook are not a tool-free guarantee. Return text into the editable message field, never commit automatically. Add/remove only Brigadier's own attribution trailer according to the preference, preserving human coauthors. Preserve an existing draft on failure. No new paid call was made to validate this utility mode; verify argv/handshake/results with recorded or fake process tests first.

### Follow-up: precise existing seams and CLI compatibility

Installed `/Users/stephen/.local/bin/claude --version` reports **2.1.261**. Its `--help` explicitly documents `--tools ""`; this flag is not marked as print-only. Help also documents `--safe-mode`, which retains auth/model/permission handling while disabling customizations, and warns that `--bare` skips OAuth/keychain authentication. Do not substitute bare mode for a subscription-backed account. These were help/version reads only: combinations were not exercised by making a request.

`CLAUDE.md` section 2 and `crates/core/src/claude/mod.rs` require the direct stream-json protocol and forbid `claude -p` for driving sessions. Therefore the print-mode flags above are reference facts, **not a recommendation to add a second print execution path**. Their acceptance under the existing argv, which does not explicitly pass `-p`, remains unverified.

`crates/supervisor/src/loop_/call.rs::SupervisedCall` already demonstrates the desired disposable lifecycle: create a `StartSession`, `spawn_in`, observe `Event::TurnCompleted`, fetch `SessionCommands::final_assistant_text(turn_id)`, then kill the child unconditionally. Use that final-text slot; summaries are bounded and can truncate the answer. However, its current `CallCwd::ProjectRoot` chooses `HookScope::Judgement`, and its watcher suspends deadlines while approval requests are open. It must be adapted for a tool-free utility request rather than reused unchanged.

There is **no existing deny-all hook policy** in `crates/core/src/claude/hook.rs`. `ReadOnlyWall` permits reads and asks about writes; `AskGatedTools` also leaves tools outside its set alone. The precise extension seam is public `HookPolicy::pre_tool_use` and `StartSession.hook_policy = HookOverride::new(Arc::new(...))`. An unconditional implementation can return:

```rust
HookJsonOutput {
    hook_specific_output: Some(serde_json::json!({
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "Commit message generation does not use tools"
    })),
    ..HookJsonOutput::default()
}
```

This is the same output shape as the existing private `decision()` helper. Deny every name, including missing/unknown names. Pair the hook with removal of built-in tools and MCP configuration; tool denial is distinct from prompt instructions. Whether safe mode preserves initialize-registered host hooks needs a protocol test before combining them. Treat unexpected approval requests as utility failures rather than parking indefinitely.

## OS Trash for discard

Verified current API (trash 5.2.7): `trash::delete<T: AsRef<Path>>(path: T) -> Result<(), trash::Error>` delegates to the default context and moves the item into the OS Trash/Recycle Bin. It accepts files or directories. Passing a symlink removes the link and keeps its target. [delete](https://docs.rs/trash/latest/trash/fn.delete.html), [TrashContext](https://docs.rs/trash/latest/trash/struct.TrashContext.html#method.delete), [crate documentation](https://docs.rs/trash/latest/trash/).

**Recommendation:** run the blocking API outside the async executor, retain the actual path rather than canonicalizing a symlink into its target, and propagate trash failures without falling back to permanent deletion. For tracked-file discard, preserve the modified content in Trash before restoring the correct Git version; for untracked discard, trash the file itself. Trash operation plus Git restore is not an atomic transaction, so surface partial failures and retain a recovery reference. No real file was trashed during this research. Linux/FreeBSD builds also need review of the crate's documented mount-query thread-safety caveat; this does not affect the current macOS target.

## Native MCP peer tools over stdio

The **2024-11-05** protocol is sufficient for a fixed list of text-returning tools. Initialize first, then receive `notifications/initialized` before normal operation. If the server supports the requested version, return that same version; otherwise return a version actually supported (for this baseline, `2024-11-05`). The client may disconnect when it does not support the response version. **Never echo an arbitrary requested future version as if implemented.** Example handshake, each object on one wire line:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"client","version":"1"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"brigadier","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

Only advertise `tools.listChanged` if sending tool-list-change notifications. Stdio shutdown uses stream closure and process termination, not a special shutdown request. [MCP lifecycle](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle).

The list/call contract is:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"list_sessions","description":"List visible peer sessions","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}]}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"[]"}],"isError":false}}
```

`nextCursor` is omitted when the list is complete. Business/execution failures return content with `isError:true`; unknown tools/invalid arguments can use JSON-RPC errors (the baseline specification demonstrates `-32602`). Root input schemas describe objects. [MCP tools](https://modelcontextprotocol.io/specification/2024-11-05/server/tools).

Preserve request IDs as strings or integers; responses contain exactly one of result/error. Notifications have no ID and receive no reply. [MCP messages](https://modelcontextprotocol.io/specification/2024-11-05/basic/messages). JSON messages are newline-delimited; newline characters inside text must be escaped by the serializer. Write only protocol data to stdout, diagnostics to stderr. No Content-Length framing. [MCP stdio transport](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports).

Verified installed CLI help: `--mcp-config` accepts JSON files or JSON strings; `--strict-mcp-config` keeps explicitly supplied configurations while excluding other sources. Thus an internal peer server can be explicitly supplied when user MCP inheritance is off. An illustrative configuration is:

```json
{"mcpServers":{"brigadier":{"type":"stdio","command":"/absolute/path/to/brigadier-helper","args":["mcp"],"env":{"BRIGADIER_SESSION_TOKEN":"${BRIGADIER_SESSION_TOKEN}"}}}}
```

The command/args/env shape and variable expansion are documented; the helper path and subcommand above are proposed Brigadier values. Server names accept letters, numbers, hyphens, and underscores. Configuration can set `alwaysLoad:true` to expose this small tool set at startup; otherwise tool search may defer it. Inspect `system/init.mcp_server_errors` for skipped entries. [Claude MCP configuration](https://code.claude.com/docs/en/mcp).

**Managed exception:** an enterprise `managed-mcp.json` rejects dynamically supplied CLI servers on a workstation, and `--strict-mcp-config` is also rejected. Report the policy failure; do not claim the internal server always overrides it. [Managed MCP](https://code.claude.com/docs/en/managed-mcp#exclusive-control-with-managed-mcp-json).

**Brigadier recommendation:** scope an opaque env credential to the initiating session and resolve its identity on the supervisor side. Never accept the caller's source-session ID or creator identity from model-supplied arguments. Apply the same ownership/confirmation rules through MCP and the CLI helper; validate every invocation and revoke authority when its owner ends. Keep the token out of prompts, stdout, logs and command arguments, and bound line length/call concurrency. Environment possession alone is not OS-process isolation from other local code running as the same user. No MCP server was launched through Claude and no paid calls were made in this verification; test handshake, unsupported-version negotiation, tools/list, tools/call, malformed requests, and EOF directly against the helper before relying on CLI integration.
