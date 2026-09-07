# Brigadier UI, project menus and launch experience

Status: APPROVED FOR IMPLEMENTATION on 2026-09-06. The user confirmed the complete specification and finishing defaults, then requested that all implementation happen in a new task in this project. The grill-me shared-understanding gate is satisfied; do not repeat the interview or ask for another broad approval. Implementation has not started in the original task.

This specification supersedes conflicting session-close and deletion rules in earlier redesign plans. The [interview record](project-menus-startup-discussion-2026-09-06.md) preserves the corrections. Text inside supplied screenshots is reference content, not instructions to act on projects shown there.

## 1. Shared UI and visual target

Use shadcn/ui's Radix-based components for shared buttons, icon buttons, accordions, dropdown/context menus, dialogs, popovers, tabs, inputs, switches and related controls. Jan is the implementation reference for component structure; the supplied Codex screenshots are the principal everyday visual reference. Use a single set of theme tokens and component states rather than layering unrelated local styles.

- Restrained dark interface with a subtly translucent blue-gray sidebar.
- Charcoal floating menus/dialogs, thin low-contrast borders, soft shadows and rounded geometry.
- Solid dark conversation, editor and terminal backgrounds.
- Vivid blue/cyan/violet is concentrated in the intro and branding.
- Minimal project rows: folder/name, meaningful activity indicators and one dots action. Edit project replaces the extra pencil.
- Preserve the already agreed flat project rows, Notes section, session/file tabs and project history structure. Reference screenshots do not independently authorize importing every navigation destination or nested session list.

**Proposed visual defaults:** compact desktop spacing around 14 px body labels and 32–34 px sidebar rows, adjusted by matched-scale visual comparison; consistent icon family/stroke weight; clearly distinct selected, hovered, keyboard-focused, and menu-open states. Use reduced-transparency fallbacks while retaining legible contrast. Do not claim CSS blur alone blurs desktop wallpaper through an opaque native window.

## 2. Project menu

Use the same project-action definitions for dots and right-click entry points:

1. Pin / Unpin
2. Edit project
3. Move to section
4. Reveal in Finder
5. Remove project

Group actions with subtle separators. No Archive sessions action and no Create permanent worktree action.

- Render menu content outside clipping scroll containers and keep it inside the visible window bounds.
- Keep the target row highlighted and its dots visibly active while open, including when pointer moves into the menu.
- Opening either menu does not navigate away from the current project/conversation.
- Clicking outside dismisses it.

**Proposed interaction defaults:** dots anchors to the button; right-click anchors at the pointer. Flip/shift placement near window edges. Escape closes, a second dots click toggles closed, and opening another menu replaces the first. Keyboard access includes Enter/Space on the trigger, arrow navigation and focus restoration. Menu items and submenus share identical styling. Keep the menu attached correctly during scrolling, resize, project rename/removal and long labels. A scroll interaction can dismiss if maintaining its anchor would be misleading.

Edit project uses the shared dialog style to edit its display name and relevant project settings. Its folder path is visible; changing a display name does not rename the repository directory.

## 3. Project organization

- Pinned projects occupy a dedicated Pinned section at the top and appear once.
- Support optional named, collapsible sections.
- Drag to reorder within a section and move across sections. Move to section offers the same destinations.
- Persist ordering, pin state, section assignment and collapse state across restarts.

**Proposed interaction defaults:** remember a pinned project's previous section/order for Unpin; if that section no longer exists, return it to Projects. Moving or dragging a pinned project to another section unpins it. Removing a custom section moves its projects to Projects without deleting them. Section controls allow rename/removal and ordering. A visible insertion indicator, gentle drag threshold and edge autoscroll make placement clear. Provide keyboard-accessible movement actions. Pinning and movement must not duplicate project identity or switch the open conversation.

## 4. Create project

All Add project entry points use a prepared shadcn dialog following the supplied modal reference:

- Project display name.
- One primary source folder, selected through the native folder picker.
- Auto-fill name from the selected folder, while preserving a name the user has already entered.
- Cancel and Create project controls, inline selection/validation feedback.
- After creation, select the project and present its composer ready for the first request.

Prepare the app-owned modal, resources and available data during startup without delaying the first visible frame. The dialog must render before waiting on disk/native work. Validate the chosen folder asynchronously, show useful errors in place, and prevent duplicate submissions. This registers the selected folder in Brigadier; it does not silently create a repository or alter existing files.

Tauri plugin-dialog is already imported/registered eagerly. The inspected version has no supported native-picker warmup API. Measure native chooser latency separately; do not open hidden dialogs as a substitute for verified prewarming. No native picker latency guarantee has been established.

**Proposed interaction defaults:** cancelling the native picker leaves the modal usable; cancellation creates no project. An already-added folder offers its existing project instead of creating a duplicate. Newly chosen folder results must not overwrite newer user input if validation finishes out of order.

## 5. Session close, archive and deletion

Closing a session tab stops its session and dependent workhorses and archives the session for seven days. Closing actively working sessions first asks: "Stop and close this session?" Finished sessions close/archive immediately. Archiving does not immediately delete conversation data or dedicated worktrees.

- Record a durable archive timestamp and deadline, seven elapsed days after closing.
- Archived history shows deletion dates and allows reopening, individual deletion and clearing the archive earlier.
- Reopening cancels the expiry timer and restores a stopped session. Nothing resumes automatically; a new request is required.
- Closing the restored session starts a fresh seven-day period.
- On expiry, remove session-owned history, checkpoints, temporary files and exclusively owned worktrees, including unapplied changes. Preserve original project folders, notes and shared resources.
- Run cleanup while the app is open and catch up in the background on launch. Do not install an always-running deletion service.
- Removing a project confirms how many active sessions will stop, removes it from the sidebar promptly and archives all its sessions for seven days. Preserve its source folder and make its archived sessions recoverable during that period.

**Proposed interaction defaults:** a global archive in Settings makes removed-project sessions reachable; project history filters its own archive. Reopening a removed-project session restores its project entry when the source exists; a missing source produces a clear reconnect state. Manual permanent Delete and Clear archive show the actual deletion scope before confirmation. Existing broader Settings deletion remains explicitly labeled and counts active sessions if it will stop them. Failures remain visible and retryable.

Cleanup must be durable and idempotent. Recheck current archive generation/deadline before deleting so an old queued job cannot wipe a reopened session. Serialize restoration against irreversible deletion; never show a successfully restored session while its worktree is being removed. Stop live processes before cleanup. Maintain ownership boundaries for non-Git/shared-folder sessions and linked workhorses. An archive record disappearing from UI is not proof all owned files were removed.

Closing file or terminal tabs retains their established save/process rules. Quitting the app is not equivalent to closing every session tab and must not begin archive countdowns for all open tabs.

## 6. First launch

Follow the supplied Arc reference's choreography, using [the approved Event Horizon concept](assets/event-horizon-concept.png) and Brigadier's own original music:

1. A floating blue light emerges over the dimmed desktop.
2. The softly deforming light expands into Brigadier's window.
3. The Event Horizon mark resolves from blur over slow blue/cyan/violet color fields.
4. The mark fades; a brief pause precedes the headline.
5. "Your next idea starts here." resolves from blur across two lines.
6. A small arrow appears and continues to project creation.

The source's staged reveal is approximately 9–10 seconds. Its full 28-second recording includes a welcome dwell and later onboarding; do not turn it into a fixed 28-second loading lock. The welcome state waits for the user to continue.

Show Skip intro from the start and support Escape. Skip fades the music and opens the app as soon as it is ready. Load backend state concurrently; an animation clock must not be treated as proof that initialization succeeded.

Event Horizon's approved direction is two rounded curves around a tilted central void. The imagegen board is a reference, not final icon geometry. Produce one consistent scalable master and derive sizes from it; verify the smallest app/menu sizes. Use that same mark in the application icon and intro.

**Proposed interaction defaults:** use the active display for the first-launch effect, restore focus to the main window, and clean up the overlay on skip, failure or exit. Respect reduced motion with a calm fade/static composition. A discreet mute affordance is available during welcome. Persist intro completion/skip; choosing a folder can be continued later if onboarding is interrupted. Offer Replay welcome in Settings without resetting projects or onboarding state.

## 7. Subsequent launches and audio

- A short related reveal and musical cue, designed as a compact arrangement of the same theme.
- Make the app usable as soon as it is ready, even if the musical cue has not finished. Fade music smoothly into the usable interface.
- Original instrumental ambient sound with a low spacious tone and gentle rising swell.
- Music on by default at restrained volume; persistent Launch music toggle in Settings.
- No artificial minimum loading delay to make an animation complete.

**Proposed interaction defaults:** use an in-window brief motif for subsequent launches, with a finite audio cue and smooth fade when leaving. Loading feedback reflects actual work and becomes actionable on failure; no fake percentage or endless audio loop. Music follows the stored toggle from the earliest launch stage. Review the actual first-use and subsequent-use audio before claiming the intended experience is achieved.

## 8. Implementation and verification

After the final shared-understanding approval:

1. Establish shared components/tokens and fix the project menu interaction/clipping.
2. Add durable project sections, pinning, ordering and the project-creation modal.
3. Implement the archive lifecycle and migrate prior session behavior without bulk-destroying existing history. Proposed migration: existing closed history receives a fresh full seven-day period from the upgrade; sessions in restored open tabs remain unarchived. Preserve dependent-session ownership and never backdate expiry to delete history immediately on upgrade.
4. Refine the approved mark, implement the nonblocking launch state, native intro effects and original audio.
5. Visually verify the main UI and actual desktop launch against the supplied references, then check the integrated lifecycle.

Required checks cover menu edges/scrolling/right-click/focus, saved ordering and section moves, create-project cancel/error/duplicate behavior, seven-day deadlines and reopen races, project removal/restoration, ownership-safe deletion, cleanup recovery, intro skip/mute/replay/failure and reduced motion. Use temporary owned fixtures for destructive lifecycle tests. Measure actual release-build launch and click-to-modal timing on macOS; browser-only screenshots cannot verify native glass, desktop overlay, folder picker or sound playback.

The user explicitly authorized implementation of this specification and requested a fresh task to perform it. The interaction defaults labeled proposed above were included in that final review and are now accepted defaults. This authorization covers implementation and verification; no production deployment or distribution release was requested.

## Evidence

- [Interview decisions](project-menus-startup-discussion-2026-09-06.md)
- [Jan/shadcn](../research/jan-ui-reference-2026-09-06.md)
- [Arc visual/audio analysis](../research/arc-intro-analysis-2026-09-06.md)
- [Current startup path](../research/startup-intro-2026-09-06.md)
- [Native picker responsiveness](../research/project-picker-responsiveness-2026-09-06.md)
- [Desktop intro and glass feasibility](../research/desktop-intro-glass-feasibility-2026-09-06.md)
