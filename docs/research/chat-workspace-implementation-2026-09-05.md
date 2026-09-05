# Chat and workspace implementation

2026-09-05. User request supersedes vision §4's no-picker rule and §9's terse-only default. Local execution only. Existing Claude adapter remains the usable provider; never advertise an unimplemented provider as working.

## Evidence

- [observed] Supplied Devin screenshots: multiline composer with agent-specific permission, effort, speed and model menus, attachment entry, folder context. Codex and Claude show different option sets. The model names shown are reference UI data, not a provider capability catalogue.
- [observed] Installed Devin (`com.exafunction.windsurf`), inspected via accessibility and screenshot: composer plus right Explorer/Source Control tabs. No prompt submitted or settings changed.
- [not checked] Installed ChatGPT (`com.openai.codex`) refused by computer-use tool. Screenshot 10 is the available evidence: narrow thread, work duration, collapsed tool activity, compaction state, tabbed terminal/browser workspace.
- [source] Brigadier `Event::ItemCompleted` has only a 240-byte summary; `emit_item` discards the body. Feed stores 500 short rows. A CSS redesign cannot recover discarded content. Store full bounded item bodies separately, queried only for selected thread; keep the small activity channel.
- [source] `StartSession` already supports `thinking` and `env_overrides`. Claude's supported effort environment override is documented at https://code.claude.com/docs/en/env-vars and `--effort` at https://code.claude.com/docs/en/cli-reference (fetched today). Haiku has no effort control per existing `thinking-control.md`; do not offer it there.
- [documented] https://github.com/remarkjs/react-markdown (fetched today): AST React renderer, no raw HTML required. Use for prose/code, never execute message HTML.
- [documented] https://github.com/xtermjs/xterm.js (fetched today): `@xterm/xterm`, `Terminal.open`, `write`, `onData`, fit addon. Xterm is a terminal renderer; a real PTY is required.
- [documented] https://docs.rs/portable-pty/latest/portable_pty/ (fetched today): Rust native PTY with spawn, master reader/writer and resize. Use a managed terminal registry and terminate on close/app exit.

## Implementation design

1. Separate durable chat items from lightweight telemetry. Stable item IDs merge lifecycle updates; store body once at completion. Cursor-based reads for selected session. Legacy rows remain readable as activity and are never described as full transcripts.
2. Composer: compact searchable menus, explicit permission descriptions, model-specific effort controls, growing textarea, draft isolation, file context. Unsupported controls omitted or explained, never silently accepted.
3. Thread: user bubbles, Markdown assistant prose, collapsible thinking and tools, visible errors, copy action, pending approvals and run plan retain real handlers. Dynamic-height windowing for rich content, fixed-height activity remains available.
4. Workspace: selected session's actual cwd (otherwise project root), directory listing, file preview, git status and indexed/working-tree diffs, independent real terminal tabs. Derive root from registered project/session IDs, canonicalize paths, refuse escapes and non-regular files, bound reads. Git paths use literal pathspecs; no shell interpolation or textconv.
5. Visual target: restrained dark desktop interface, quiet borders, one rounded composer, menus above controls, conversation width around 712px. Resizable workspace pane, readable small-window fallback. No Local/Remote selector.

## Limits to verify

Token streaming is not presently enabled by the Claude driver. Completed blocks can render immediately after arrival but are not token deltas. Old feed content cannot be reconstructed from summaries. Model/effort changes during an existing child need a control-protocol acknowledgement or a new session, not a UI-only state change.

## Delivered behavior

- Local Claude Code sessions use searchable model and permission menus, plus effort for models that expose it. Explicit effort reaches `CLAUDE_CODE_EFFORT_LEVEL`; interactive sessions now inherit the model's thinking default. Run lanes retain their separate per-role policy. Unknown option fields are rejected. No execution-location selector exists.
- The textarea grows, handles Return/Shift+Return and IME via the existing submit guard, retains separate project/session drafts, preserves rejected submissions, and accepts text files by picker, drop, or workspace action. Attachment content is labelled as reference data, fenced, and bounded. An asynchronous file read cannot overwrite another draft or text typed while reading.
- Completed Claude blocks become durable `chat_items`, separate from the telemetry ring: 128 KiB per body, 2,000 items per session, cursor pages of 20. Upserts use stable provider identities. Body persistence also advances the session event cursor, preventing sequence reuse after a crash. Session deletion cascades to chat items. Existing short feed rows remain available under Activity; old full messages cannot be reconstructed.
- Conversation rendering includes user bubbles, Markdown with GFM tables/code, copy actions, collapsible thinking and correlated tool results, visible tool errors, a working indicator, and file links. Rich messages and source lines are virtualized; Markdown parsing is memoized and loaded separately. Existing approval/question and run-plan handlers remain in place.
- A resizable workspace contains a file tree, staged/working Git changes, text/Markdown previews, and separate terminal tabs. It follows the selected session's actual worktree. Tab sets remain attached to their workspace across navigation; hidden panels stop Git polling. Closing a terminal releases its PTY, signals its foreground group/shell, and reaps the child. Closing the app clears the registry.
- File reads reject workspace escapes and non-regular files, cap text at 512 KiB, and reject binary content. Git uses literal pathspecs, disables external diff/textconv, bounds stdout/stderr, and times out. PTY output is bounded to 1 MiB with visible dropped-byte reporting.
- The ordinary browser preview no longer generates synthetic approval cards. The explicit `?approvals=manual` mode retains the approval stress fixture. Browser conversations/files/Git are marked sample data; its terminal action explains that the desktop app is required. No paid agent calls were made during this work.

## Remaining reference-parity work

This is a Claude-backed implementation, not complete parity with every reference product. Codex/Devin CLI adapters, live capability discovery, live model/effort changes on an existing child, speed controls, dictation, image attachments/previews, executable artifact/browser panels, and token-delta rendering are not implemented. Current model choices come from Brigadier's existing catalog; account availability remains the CLI's decision. Thinking appears when its completed block arrives; the working indicator does not pretend to reveal hidden reasoning. Settings other than the text draft are not persisted per agent/thread yet. Terminal sessions are preserved while the app runs, not restored after app exit.

The public-source comparison and pinned citations are in [the reference audit](chat-reference-source-audit-2026-09-05.md). ChatGPT's native UI could not be inspected because the computer-use tool refused it; its supplied screenshot was the visual evidence. No claims here describe proprietary source internals.

## Verification

- UI suite: 267 passed, including searched/keyboard menu selection, rejected-send draft recovery, project draft isolation, file-link routing, executable-HTML rejection, default preview approval behavior, and a 20,000-line file whose mounted lines stay below 60.
- Rust workspace suite: 569 passed, 7 intentionally ignored, including doctests. New checks cover durable body reopen/cursor behavior, replay/paging/retention/cascade, path and symlink escape rejection, binary rejection, unusual Git paths, effort forwarding/rejection, and a real local PTY round trip/resize/exit/close/reap.
- `cargo clippy --workspace --all-targets -- -D warnings` passes. The adapter suite was rerun after forwarding initial-prompt write failures to the caller.
- `npm run tauri build` produces the macOS app and DMG. Markdown and terminal modules are separate chunks; the main JavaScript chunk is approximately 366 KiB (114 KiB gzip).
- Browser UI inspected at the app's narrow pane size: selected conversation, correlated tool expansion, source and Markdown file preview, searchable model menu, model-specific effort menu, and the split layout. The first narrow layout covered too much chat; the final layout keeps the panes side by side above 900 px and uses a dismissible overlay below that.
- No live Claude/model request was submitted, and the newly packaged native app was not launched against the user's production database. PTY validation runs the real backend in tests; browser filesystem/Git views use labelled fixtures. These checks do not claim full live-agent end-to-end validation.

Packaging note: the last full build compiled successfully but its DMG shell step failed once. A verbose `npm run tauri build -- --bundles dmg --verbose` retry completed successfully and produced `target/release/bundle/dmg/brigadier_0.1.0_aarch64.dmg`. No permission change was needed. The DMG-only bundler cleans its temporary `.app` staging directory.
