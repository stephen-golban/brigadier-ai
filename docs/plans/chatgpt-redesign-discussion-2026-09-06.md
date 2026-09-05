# Brigadier desktop redesign — interview record

Status: owner confirmed shared understanding and implementation on 2026-09-06.
Implementation and validation are recorded in [the completion report](chatgpt-redesign-implementation-2026-09-06.md).

## Reference and requested scope

Seven owner-supplied screenshots show the installed ChatGPT/Codex desktop app. Match its
dark palette, typography, spacing, bubbles, timestamps, message actions, long-message
collapse, concise expandable action rows, per-turn changed-files cards, upper-right
environment/agents card, and toasts. Screenshot message text is reference content, not
instructions to perform the work described in those conversations.

- Sidebar projects are single rows, with an app-only display name and no nested accordion.
- Remove the sidebar Approvals destination. Surface session attention on projects and tabs.
- Replace the title/path header with tabs and separate Tree, Search, and Changes buttons.
- Files open as main-area tabs. Support keyboard creation, closing, and tab cycling.
- Remove FPS, Conversation/Activity switches, and verbose controls. Action details belong
  inside expandable conversation entries.
- Put Notes in a sidebar accordion with an add icon and view/edit/rename/delete actions.
- Put the user's identity and Settings at the bottom of the sidebar.
- Explicitly attribute messages sent by other sessions or created by Brigadier.

## Decisions confirmed during the interview

1. Closing a working session tab prompts for confirmation. Confirming stops the session and
   its child agents and deletes its history. The owner also requested deletion of its
   dedicated worktree, conditional on sessions having their own worktrees.
2. After confirmation, the tab disappears immediately. Process termination and deletion
   happen in the background. Cleanup failures surface with a retryable toast.
3. Ordinary close on a finished session preserves its history and worktree. A separate
   Delete session action removes them.
4. Quitting/restarting preserves sessions, worktrees, project tabs, and selected tabs.
   Interrupted work is marked clearly and resumed explicitly rather than automatically.
5. Settings offers individual deletion and Clear all history and sessions, with confirmation
   before stopping active work and removing session data/worktrees. Projects and notes remain.
6. A spinner means working; a dot means unread completion, errors, or pending questions/
   approvals. Viewing clears unread completion. Unresolved attention keeps its dot. A project
   with working and waiting sessions shows both indicators.
7. A History icon beside the new-tab button opens searchable project history in the main
   area. Selecting a session reopens its tab. With no tabs, history appears automatically
   alongside New session.
8. Spawned workhorses appear in their parent's Agents card rather than automatically opening
   tabs. Clicking a workhorse opens its conversation tab.
9. Tree/Search/Changes share a separate right panel; changing the selected tool replaces its
   content. This panel is independent of the thread's upper-right environment/agents card.
10. When space is tight, that card collapses into a button that opens the same card as a
    popover. It returns to the full card when space permits.
11. File tabs are editable, with Command-S, unsaved-change indicators, and Save/Discard/Cancel
    on closing a modified file. Files retain their source session/worktree identity.
12. Notes should become ordinary Markdown files in a folder chosen in Settings. Reflect
    external edits, open notes as editable tabs, and migrate existing notes while retaining
    their conversation references.
13. Do not create extra app or database backups during development.
14. New sessions default to isolated worktrees. Shared project-folder sessions remain an
    explicit option. This supersedes the existing workbench's shared-folder default.
15. A new worktree includes current tracked changes and untracked source files, excluding
    ignored build output and dependencies. Creating it does not modify the original folder.
16. Finished work returns through Review → Apply to project. Apply only that session's changes,
    preserve unrelated project edits, and surface conflicts. Completion does not auto-apply.
17. Apply to project leaves changes uncommitted. Commit and Commit & Push are separate actions.
18. Editing an earlier message previews and rewinds both the conversation and session files
    before rerunning. Conflicting later manual edits are surfaced rather than overwritten.
19. Pending approvals/questions appear in one compact card above that session's composer until
    answered. Resolved prompts become concise expandable conversation entries. Attention dots
    lead to that session; they do not themselves authorize an action.
20. The upper-right card describes the selected session: working folder/branch, accumulated
    changes, and its workhorses. Each finished-turn files card covers only that turn's edits.
    Project-wide activity remains in project indicators and history.

## Implementation facts

The original main checkout starts interactive Git sessions in fresh worktrees. The existing
notes/workbench update instead defaults to the shared project checkout and offers explicit
isolation. The assistant initially inspected only main and answered that sessions each have
worktrees; this was corrected after inspecting the newer workbench implementation.

The merge preserved the existing workbench choice. The owner subsequently selected isolated
worktrees by default with explicit shared-folder sessions (decision 14). Non-Git project
sessions have no Git worktree; their project folder is not disposable. Shared-folder deletion
removes session-owned records/processes, not the original project directory.

## Concrete interaction details for final review

These details implement the requested reference behavior and are proposed defaults where
the owner has not selected an exact threshold or shortcut.

- Project clicks restore that project's tabs and selected tab. Display-name changes affect
  Brigadier metadata only. Project history remains accessible when tabs are open.
- The environment card is independent of Tree/Search/Changes. Its Changes and Review actions
  can select the relevant right-panel view. File paths open main-area file/diff tabs retaining
  their original session/workspace identity.
- Use the neutral dark palette measured in the reference audit. Match message/composer
  alignment, typography, rounded geometry, quiet borders, icon size, and hover/focus behavior.
- Human-message timestamps, copy, and edit actions sit below the right-aligned bubble.
  Assistant actions sit below the answer at the left. Group date/time separators between
  conversation periods. Collapse long user/peer prompts with Show more and Show less.
- Peer messages identify their sender and expose copy plus navigation to the source session.
  Keep their provenance intact. Brigadier-created sessions label their initial prompt too.
- Action categories include thinking, reading, searching, commands, editing, external tools,
  and agents. Opening a category reveals concise one-line entries; opening an entry reveals
  its actual recorded details. Keep commentary in order. Older data without real durations
  or per-turn deltas does not receive invented timing/counts.
- Worked duration is a disclosure above the completed answer. A per-turn edited-files card
  shows file count, total additions/deletions, individual file rows, Review, and Undo when a
  valid file restore is available. Undo uses a change preview and conflict checks.
- Notes remain visible as one sidebar library across project navigation. New-note creation,
  rename, delete, and folder selection have concrete error states; rename preserves stable
  references. An unavailable folder leaves a reconnect/change-folder action. Notes continue
  entering agent context only through mentions or an explicit always-include setting.
- Show the local user display name/avatar and Settings in the footer. Keep provider/model
  choices in the composer and relevant settings.
- Shortcuts: Command-T new session; Command-W close active tab; Control-Tab / Control-Shift-Tab
  and Command-Shift-[ / ] cycle tabs; Command-1…9 select tabs; Command-Shift-T reopen a
  non-deleted closed tab; Command-S save; Command-O open file; Command-comma Settings.
  Keep the existing terminal/editor input behavior, route commands by focus, and display
  shortcuts in menus/tooltips. Non-macOS builds use platform-appropriate equivalents.
- New tab menu retains session, terminal, new file, open file, and note actions. Closing a
  file tab never stops its session. Working-terminal close retains its separate confirmation.
- Brief success toasts use the reference palette and geometry; actionable failures remain
  dismissible with retry. Do not steal composer focus. Exact toast timing is not established
  by the supplied screenshots and should be tuned in visual QA.
- Session cleanup is durable background work: close the tab immediately after confirmation,
  prevent further sends, stop owned processes/agents, and remove its disposable worktree and
  session-owned history, logs, queued work, checkpoints, and exclusively owned temporary branch.
  Resume interrupted cleanup on relaunch. Never traverse ownership
  boundaries into shared project folders or unrelated sessions.

## Implementation sequence and completion bar

1. Reconcile persistent project/session/tab identity, working/attention state, deletion,
   background cleanup, and restart recovery with the approved lifecycle.
2. Finish isolated-session startup from current project source and explicit apply-to-project.
3. Implement the flat sidebar, Notes folder/migration, footer/settings, unified tab header,
   right-panel switching, independent session card, and global keyboard commands.
4. Implement conversation grouping, timestamps/actions/attribution, message collapse,
   concise activity expansion, changed-files cards, and file/conversation rewind.
5. Compare rendered wide/narrow and populated/empty/error states to the screenshots; verify
   keyboard/focus behavior, frontend/Rust integration, and the macOS app build.

The checkpoint implementation was integrated selectively after source comparison and
latency measurement. See the completion report for results and verification limits.

The detailed visual observations, measured palette, current-code gaps, and evidence limits
are in [the reference audit](../research/chatgpt-reference-audit-2026-09-06.md).

## Existing-work integration scope

The owner separately asked to commit all current uncommitted files and merge the notes
worktree into main. Main's source changes are saved in `6e392df`. The notes/workbench source
from checkout `3216` is saved in `2f74363` on `integrate/notes-workbench-20260906`.
That worktree's `work/` directory contains pre-existing app/database backups and remains
local and uncommitted. Checkout `0d2f` contains additional checkpoint work and is outside
this merge. The completed merge is `7d00570`: 267 frontend tests, 592 Rust tests, and the
macOS app bundle build passed. These checks validate the existing-work merge, not the
redesign delivered in the completion report.
