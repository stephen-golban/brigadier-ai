# Workbench implementation — 2026-09-05

Implemented in the isolated Codex worktree at `/Users/stephen/.codex/worktrees/3216/brigadier-ai`. No commit, push, installation, or paid provider call was made.

## Implemented behavior

- Project tabs for sessions, terminals, files, unified diffs, untitled buffers, and notes. The tab **+** menu offers New Session, Terminal, New File, Open File, and New Note. Removed the obsolete panel that had a separate terminal button.
- Shared project checkout is the default for interactive sessions. Explicit isolation uses the existing worktree creation path. The orchestration loop retains its existing isolated worktree behavior.
- Explorer, Source Control, and Search operate against the selected workspace/session directory. The overview navigates changes, branch actions, sessions, and open file/note sources. Sidebar collapse, project selection, tab layouts, drafts, editor view positions, and conversation scroll state persist.
- Source Control supports file/hunk/range staging and unstaging, new/deleted text file ranges, rename unstaging, staged messages, commit/amend/undo, branch checkout/create/merge/rebase, remotes, publish, fetch/pull/push/sync, stash actions, and history. Destructive file actions have confirmation and use Trash for recovery. Git path arguments are literal, and partial staging rejects a changed diff.
- Commit settings offer Auto, session model, and CLI model choices, global defaults and project overrides, optional attribution (off), smart commit, and untracked-file display. CLI initialization supplies account-visible models when available. Auto selects the cheapest documented available Claude family and refuses an unknown catalog instead of inventing a price ranking. Text-only generation has tool denial, a timeout, cleanup, and process tracking; only the staged diff is sent.
- Untitled files use Monaco with language selection, supported language services, persistent local buffers, and checked Save/Save As in the current workspace. Existing disk changes are not silently overwritten.
- Project/global notes autosave with revision checks. Save queues survive quick tab switches. Note mentions reach the composer and can be reopened from rendered links. Only mentioned notes and explicitly always-included notes enter model context. **Always include defaults off.**
- Project search supports include/exclude globs, case matching, whole words, regular expressions, a replacement preview, and confirmation before replacement. All before-images are checked before writing, each write is checked again, and a later failure triggers a best-effort rollback without overwriting newer external edits.
- Native app-owned MCP tools allow agents to list/create project sessions, exchange work or passive information, read an inbox, and stop/close sessions. Per-session environment credentials establish caller identity. Work queues preserve order and wait while a peer is busy. Information does not wake agents. Stopping cancels pending work; restart does not replay it. Creator-owned targets may be managed autonomously; other targets require owner confirmation. Global/project controls can disable creation or messaging and require confirmation for child management too.
- Terminals remain mounted across project/tab navigation. A foreground command triggers close confirmation. Restoration uses recent output and cwd snapshots with a fresh shell and no command replay. Closing sessions preserves history and files.

## Verification — measured

- `npm test`: **270 passed**, 15 test files. Includes tab/buffer restoration, preserved terminals across project navigation, busy-close confirmation, note flush on immediate tab switch, note-link routing, and smart-commit cancellation.
- `cargo test --workspace`: **584 passed, 0 failed, 7 ignored** across 37 result groups. No ignored live tests were enabled.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Frontend type checking and production build: passed. Monaco and terminal code load separately from the main application bundle.
- `npm run tauri build -- --bundles app`: produced `target/release/bundle/macos/brigadier.app`.
- Packaged binary `--peer-mcp`: a local fixture exercised initialization with an unsupported future protocol version, initialized notification, six-tool discovery, an authenticated tool call, JSON-only stdout, and clean exit. A forged request token was replaced by the test environment credential. No app window or provider session was opened by the helper.
- Temporary Git repositories verified selected replacement staging/unstaging, partial new/deleted files, stale-diff refusal, unusual literal filenames, unborn-index unstaging, and both paths of an unstaged rename.
- Real local PTYs verified shell input/output, process exit and reaping, idle/foreground busy distinction, and close.
- Browser UI inspection at 1280×720 and 800×600 verified the tab menu, recovered TypeScript scratch text, live String IntelliSense suggestions, notes, mentions, commit options, global session settings, and centered dialogs. A fresh final-bundle preview loaded its conversation and editor with no console error/warning entries. An earlier preview reported a stale dynamic-import URL when its assets were replaced during a rebuild; a fresh load of the final bundle resolved it.
- The 46 imported baseline files in the original checkout still match their recorded SHA256 hashes. Concurrent `docs/research/acp.md` was not changed.

## Scope and unmeasured boundaries

This implements the requested workbench workflows using Brigadier styling; it is not a complete replacement for every VS Code feature.

- Monaco provides bundled JS/TS, JSON, CSS, and HTML language services. Other listed languages have syntax support; arbitrary VS Code extensions and their language servers are not hosted.
- The diff view is unified. Renamed files and symbolic links use whole-file staging/unstaging. There is no three-way merge editor.
- Regex uses the Rust regex engine; unsupported lookaround/backreferences produce an explicit error. Search/results, previews, replacements, notes, and terminal history are bounded.
- Save As currently creates a file inside the current workspace and refuses an existing destination. Arbitrary filesystem destinations and overwrite dialogs are not implemented.
- Live account model availability, paid commit-message generation, and end-to-end peer behavior through a real Claude model were not exercised. The native protocol, frontend behavior, authorization paths, queues, filesystem operations, and provider command wiring were checked without paid calls. Managed enterprise CLI configuration can restrict MCP configuration.
- Terminal recovery is a periodic best-effort snapshot, not a guarantee of every last output byte after a crash. Shell startup configuration runs normally when a fresh shell starts.

External interface decisions and primary-source links: [workbench interfaces](workbench-interfaces-2026-09-05.md). Approved scope: [workbench plan](../plans/workbench-2026-09-05.md).
