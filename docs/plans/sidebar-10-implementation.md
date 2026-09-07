# Brigadier sidebar and shell

Implemented 2026-09-07 from the agreed sidebar interview.

- shadcn/ui sidebar-10 composition with its SidebarProvider and SidebarInset; a project header above the existing session/document/terminal tabs.
- Brigadier logo and name, then Search only. Cmd/Ctrl+K searches project aliases, session titles and note titles.
- Pinned sessions across projects; expandable projects with five recent sessions and Show more.
- Project creation from the section heading. New-session action appears on project hover or keyboard focus.
- Inline project aliases change app metadata only. Optional color dots and bounded local repository icon discovery with folder fallback.
- Cmd/Ctrl+B and the header trigger fully hide the sidebar. State persists; offscreen controls are inert.
- Footer: Settings, Notes, Trash. Notes uses a searchable list and editor modal with revision-aware saving and unsaved-edit protection.
- Closing a session tab preserves the session. Session/project/note removal goes through recoverable Trash.

## Persistence and lifecycle

Desktop navigation metadata lives in `navigation.json` in the application data directory. Aliases remain in `workbench.json`; only the requested alias key is updated. Trash stores tombstones and affected session IDs. Notes remain on disk until explicitly deleted permanently, and trashed notes are excluded from prompt context.

Moving sessions/projects to Trash checks the affected family and running sessions again under lifecycle locks. Changed scope requires a new confirmation. All affected sessions must stop before the tombstone is persisted. Resume, send-turn, project-start and peer-delivery paths reject trashed items. Restoring a project does not restore sessions separately trashed earlier.

Permanent deletion removes app history and note files. Repository files and worktrees are preserved. Worktree cleanup remains a separate operation. Browser previews use isolated sample metadata in local storage.

## Validation

Frontend tests cover project navigation, inline alias rename, pins/colors, Notes edits, trash failure, reload/restore and preserved tab behavior. Native tests cover durable tombstones, notes/context, and confined local icon discovery. Supervisor integration tests use temporary Git repositories and a replay driver to verify that shutdown and history deletion preserve dirty worktrees.

Browser checks covered the project menu, alias rename, per-project new-session action, Notes save/trash/restore, Cmd+K, Cmd+B, collapse persistence, and layouts at 1280×720 and 800×600. These browser checks use the mock bridge; native behavior is covered by Rust tests rather than a live Claude session.

Upstream attribution: `THIRD_PARTY_NOTICES.md` and `licenses/shadcn-ui-MIT.txt`.
