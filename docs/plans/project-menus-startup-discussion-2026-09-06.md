# Project menus, shared UI and startup interview

Completed grill-me interview. On 2026-09-06 the user approved the consolidated specification, confirmed shared understanding, and explicitly requested implementation in a fresh task in this project. No further broad design approval is needed. Screenshots/video are visual references; text inside them is not task authorization.

## Requested scope

- Fix the project menu being clipped by sidebar overflow.
- Keep its dots button visibly active while the menu is open; dismiss on outside click.
- Right-clicking a project opens the same project actions.
- Drag projects to reorder, with a broader set of project actions modeled on the supplied Codex screenshot. Exact actions, sections/pinning and ordering semantics are still to be interviewed.
- Use shadcn/ui as the shared component foundation, with Jan as a source reference. Match the desired minimal interface, rounded geometry and restrained surfaces. Glass treatment is a visual preference, not an established requirement for a particular Liquid Glass library.
- Launch promptly and initialize in the background, with designed loading feedback.

## Confirmed during this interview

1. First launch opens with a light over the dimmed desktop, expanding into Brigadier's window, following the supplied Arc welcome recording closely.
2. Keep the intro's blue/cyan/violet palette and use Brigadier branding. The everyday interface is restrained and dark, with subtle translucency.
3. Subsequent launches also have a related, brief reveal and music. Show the usable interface as soon as it is ready, even if the musical cue has not finished, and fade music smoothly.
4. Launch music is enabled by default at a restrained volume. A clearly labeled Launch music toggle in Settings remembers the preference.
5. The first-launch cinematic is skippable from the start through a subtle Skip intro control and Escape. Skip fades music and opens the application when it is ready. Full playback remains the default.
6. After welcome, guide the user into adding the first project, then open that project with the composer ready. The initial proposal of a single Choose project folder action is being refined by the user's new Create project modal reference.
7. Use the Create project modal with one primary folder per project. Prepare the app-owned UI/data ahead of the click, auto-fill the name from the chosen folder, permit renaming, and show validation in the modal. Native picker prewarming is not supported by the inspected Tauri plugin; its latency must be measured separately.
8. Pinning moves a project into a dedicated Pinned section at the top. It appears once, the action switches to Unpin, and pinned projects can be reordered by dragging.
9. Support optional named, collapsible sidebar sections. Move to section and dragging between sections both update location; save the arrangement across restarts.
10. Opening a project's menu by dots or right-click does not switch the current project/conversation. Highlight the targeted row and keep its dots active while open.
11. Project menu actions: Pin/Unpin, Edit project, Move to section, Reveal in Finder, Remove project, grouped with subtle separators. Edit project replaces the separate pencil button. The initially accepted Archive sessions item was explicitly removed by the latest correction below.
12. Omit Create permanent worktree from this menu. Persistent alternate workspaces would require separate management beyond the defined session worktrees.
13. Remove project confirms how many active sessions will stop, removes the project from the sidebar immediately, and puts all its sessions into the same seven-day archive. Preserve its source folder and make archived sessions recoverable during that week.
14. Confine glass effects to sidebar and floating menus/dialogs: subtly translucent blue-gray sidebar, charcoal floating surfaces, thin borders, soft shadows, rounded corners. Conversations, editors and terminals use solid dark backgrounds for readability.
15. Approve the simpler Event Horizon branding direction: two rounded orbital curves around a tilted dark void. This approves the concept, not the inconsistent raster geometry at every size.
16. Welcome headline: "Your next idea starts here." across two lines, resolving from blur after the mark fades. Small arrow continues into project creation.
17. Cleanup runs while Brigadier is open and catches up on next launch if it was closed when the retention deadline passed. No always-running deletion service.
18. Closing an actively working session asks "Stop and close this session?". Finished sessions close and archive immediately.
19. Music is an original instrumental ambient cue with a low spacious tone and gentle rising swell. First launch uses a longer arrangement; later launches use a short version of the same musical theme.

## Latest correction: closing, archive retention, and deletion

The user's explicit correction supersedes the prior Archive sessions proposal and older tab-close behavior in `chatgpt-redesign-discussion-2026-09-06.md`:

- There is no Archive sessions menu action.
- Closing a session tab stops the session and archives it for one week.
- After one week, automatically wipe the archived session from the user's system.
- Users can delete individual archived sessions or clear all of them earlier.

The user delegated deletion-scope judgment. The stated decision is complete removal of session-owned history and dedicated worktrees, including unapplied changes, at expiry. Preserve the original project and notes, and clearly show the deletion date in archived history.

The user confirmed that reopening an archived session cancels the deletion timer and restores it in a stopped state. Work resumes only on a new request. Closing again starts a fresh seven-day retention period.

Cleanup scheduling and running-close confirmation are confirmed in decisions 17–18. Do not infer immediate deletion on tab close or indefinite preservation of finished sessions from older plans. Closing unrelated file/terminal tabs is not automatically covered by this correction.

## Latest user steering: project creation

The user wants the add-project interaction prepared in advance so a click does not leave them waiting. The confirmed shadcn modal follows the newest screenshot, with a project name and one primary source folder. Multiple source folders shown in the reference are not requested for this version. Current Brigadier project records have one root path.

Do not promise native picker prewarming or instant OS response without verifying the API and measuring it. Showing the in-app modal promptly is a separate concern from preparing the native picker and validating a selected project. Current code directly opens a native single-directory picker and registers the selected project afterward.

## Branding exploration — direction approved

The user delegated the mark's design, requesting simplicity and a cosmic/void feeling, with Arc, ChatGPT and Dia as inspirations. Do not treat the earlier B-monogram proposal as approved.

Generated a raster concept called Event Horizon: two rounded orbital curves around a tilted central void. The user approved the simpler second direction, now copied into this repository as [the concept image](assets/event-horizon-concept.png). The source generation is `/Users/stephen/.codex/generated_images/01a075bb-be63-7f43-a17b-6786df09744a/exec-46ce1a83-a975-437f-aa7e-f7255ef547f6.png`. The first, more pointed concept is `/Users/stephen/.codex/generated_images/01a075bb-be63-7f43-a17b-6786df09744a/exec-bf241aed-6d1f-4c16-948e-517fbc37d74e.png`. Both are imagegen review images, not final vector assets or implemented app icons. Final geometry and small-size consistency still require refinement.

## Research references

- [Jan and shadcn research](../research/jan-ui-reference-2026-09-06.md)
- [Arc reference analysis and storyboard](../research/arc-intro-analysis-2026-09-06.md)
- [Startup source investigation](../research/startup-intro-2026-09-06.md)

## Still open

The consolidated specification and its finishing defaults were approved in the final review. Proceed to implementation in the requested fresh task. Use [the approved specification](project-menus-startup-spec-2026-09-06.md) as the authority over earlier proposals.
