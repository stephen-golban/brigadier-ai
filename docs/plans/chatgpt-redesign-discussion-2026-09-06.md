# Brigadier desktop redesign — interview record

Status: design discussion in progress. The owner requested the grill-me interview and has
not yet confirmed shared understanding or authorized implementing this redesign. The
separately requested commit/merge of existing work is authorized.

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

## Implementation facts and the remaining worktree decision

The original main checkout starts interactive Git sessions in fresh worktrees. The existing
notes/workbench update instead defaults to the shared project checkout and offers explicit
isolation. The assistant initially inspected only main and answered that sessions each have
worktrees; this was corrected after inspecting the newer workbench implementation.

The merge preserves the existing workbench choice. The redesign still needs an explicit
decision about default/mandatory worktree isolation before finalizing destructive close.
Non-Git project sessions have no Git worktree; their project folder is not disposable.

Other unresolved branches include the exact scope of the environment card and change
summaries, handling saved/unmerged work on deletion, note-folder recovery and reference
behavior, detailed action/message presentation, shortcut mapping, and final visual review.

## Existing-work integration scope

The owner separately asked to commit all current uncommitted files and merge the notes
worktree into main. Main's source changes are saved in `6e392df`. The notes/workbench source
from checkout `3216` is saved in `2f74363` on `integrate/notes-workbench-20260906`.
That worktree's `work/` directory contains app/database backups and remains local and
uncommitted. Checkout `0d2f` contains additional checkpoint work and is outside this merge.
