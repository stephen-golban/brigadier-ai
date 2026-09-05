# Approved workbench phase

Owner confirmed shared understanding on 2026-09-05. This supersedes older no-picker, worktree-only and terse-chat guidance.

- Project-owned session, terminal, file, diff, and note tabs; + menu is the sole terminal creation UI.
- Shared checkout default; explicit isolation. Workspace follows active session root.
- VS Code Source Control behavior in Brigadier styling; Explorer Git decorations; search/replace with filters and preview.
- Commit generation: Auto cheapest supported, session model, explicit CLI model; global defaults/project overrides, attribution off.
- Monaco untitled buffers persist without Save As. Project/global notes autosave, @mentions, Always include off.
- Agent-created ordinary sessions with origin links, peer messages, passive information, queued work without interruption; creator can stop/close children, others need owner confirmation.
- Busy close confirmation, idle terminal close immediately. Terminals survive navigation; restart restores recent output/cwd and fresh shells without command replay.
- ChatGPT-like sidebar and overview navigation, responsive animated panes, state preservation.

## Baseline

Copied 46 uncommitted changed files from the original checkout at identical HEAD 1e6d2dd. Read-only source verified by SHA256. Snapshot: /tmp/brigadier-phase2-base-1788615809. Concurrent acp.md excluded. No commits/publishing.

## Work tracking

Implementation and offline verification completed. See [implementation report](../research/workbench-implementation-2026-09-05.md) for delivered behavior, test results, and explicit scope boundaries. Live provider behavior remains unmeasured; no paid provider calls were made.
