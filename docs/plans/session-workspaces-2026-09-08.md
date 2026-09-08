# Session workspaces

Approved after the design interview on 2026-09-08.

Each sidebar session owns one conversation, its open documents/reviews, and its terminal groups. The header shows a clickable session title and native three-dot menu, followed by a vertical divider when documents are open and then document tabs. Clicking the title returns to the conversation. There is no session close button or new-tab menu; new sessions are created through the sidebar or Cmd+T. Existing panel actions stay at the right edge.

The native session menu contains Rename (Option+Cmd+R), Pin/Unpin (Option+Cmd+P), Archive (Shift+Cmd+A), and a Fork submenu. Rename uses a centered dialog with the current name selected, a short description, Cancel, and Save. Fork offers the existing directory or a new worktree. Same-directory forks do not own the parent's worktree, so cleaning up the fork cannot delete its parent's directory.

Files and reviews are closable tabs. Cmd+W closes the selected document and does nothing on the conversation. Session switching restores open documents, draft contents, the selected view, terminal visibility, and terminal groups. Old project tab layouts migrate once into session workspaces, keeping recovery-buffer IDs. Unowned project files are assigned to the project's selected session, or its first saved session when no session is selected.

The terminal uses xterm.js and local PTYs in a resizable bottom pane. It supports multiple shell profiles, terminal groups, side-by-side splits, adjustable split widths, group and pane navigation, and individual terminal termination. New shells use the configured login shell unless a profile is selected. Split shells inherit the parent's working directory within the session workspace. On macOS, Ctrl+backtick toggles the terminal; Ctrl+Shift+backtick creates one; Cmd+J toggles the pane; Cmd+backslash splits; Shift+Cmd+brackets navigate groups; Option+Cmd+arrows navigate panes. Delete in the terminal list kills the selected terminal, confirming when a command is running.

Hiding the pane or switching sessions keeps shells running. Archiving stops AI work, child agents, and owned terminals, with one confirmation when AI work or commands are running. Document drafts and terminal layout/output remain available for restoration. Quitting stops processes; restoration starts fresh shells and restores scrollback without rerunning commands.

Validation covers workspace migration and isolation, draft restoration, archive/restore, document close behavior, terminal profile and split behavior, native menu icons/accelerators, real PTY I/O/lifecycle, and both fork modes. Browser and isolated macOS app previews are used for visual and native interaction checks. No installed app is replaced by this task.

Completed validation: 375 frontend tests, 169 supervisor tests, and 100 native application tests passed. Production frontend and isolated macOS app builds passed. Native checks verified the rename shortcut and saved title, both Fork submenu choices, shell command output, restored scrollback, split working-directory inheritance, and live terminal preservation across session switches. Fork execution is covered by automated provider fixtures rather than a live paid provider session.
